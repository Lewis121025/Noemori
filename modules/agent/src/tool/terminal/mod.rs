//! 会话级终端工具：命令执行、PTY 交互、增量输出、显式停止与资源清理。

#[cfg(unix)]
mod backend;
mod buffer;
mod contract;
#[cfg(unix)]
mod sandbox;
#[cfg(unix)]
pub use sandbox::{NetworkAccess, SandboxConfig, SandboxMode};
#[cfg(unix)]
mod io;
#[cfg(unix)]
mod manager;
#[cfg(unix)]
mod process;
#[cfg(unix)]
mod worker;

pub use contract::{
    TerminalInfo, TerminalInput, TerminalObservation, TerminalOutput, TerminalStatus,
    TerminalSummary,
};
#[cfg(unix)]
pub(crate) use manager::Manager;

use super::{Tool, ToolContext, ToolError};
use crate::Error;
use async_trait::async_trait;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::Duration;

/// 无可变进程状态的工具配置；会话决定进程归属，注册表克隆不会混合不同对话。
///
/// 支持 macOS/Linux；默认仅工作区可写、网络关闭，宿主可显式调整权限。
/// 每次 exec 启动新的非登录 shell，cd、export 不会影响下一次 exec。
pub struct TerminalTool {
    workdir: PathBuf,
    shell: PathBuf,
    description: String,
    #[cfg(unix)]
    policy: sandbox::Policy,
}

impl TerminalTool {
    /// 使用宿主 SHELL（未设置时为 /bin/sh）和给定默认目录创建工具，不启动进程。
    ///
    /// `workdir` 会解析为绝对目录；返回可注册的工具。
    /// # 错误
    /// 目录或 shell 无效、沙箱启动器不可用、平台不支持时返回配置或能力错误。
    pub fn new(workdir: impl AsRef<Path>) -> Result<Self, Error> {
        let shell = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .unwrap_or_else(|| "/bin/sh".into());
        Self::with_shell(workdir, shell)
    }

    /// 使用宿主明确指定的 POSIX shell；shell 路径不会作为模型可修改的参数。
    ///
    /// `workdir` 是默认目录，`shell` 是可执行文件路径；返回不持有进程的工具。
    /// # 错误
    /// 路径或沙箱启动器无效、shell 不可执行或平台不支持时返回错误。
    pub fn with_shell(workdir: impl AsRef<Path>, shell: impl AsRef<Path>) -> Result<Self, Error> {
        #[cfg(unix)]
        {
            Self::configured(workdir, shell, SandboxMode::default())
        }
        #[cfg(not(unix))]
        {
            let _ = (workdir, shell);
            Err(Error::Unsupported("终端工具只支持 macOS/Linux".into()))
        }
    }

    /// 用宿主提供的工作目录、POSIX shell 和权限创建工具；模型不能改变 sandbox。
    ///
    /// 默认构造器使用受限模式；只有宿主传入 Disabled 才保留完整环境与系统权限。
    /// # 错误
    /// 路径、授权或受保护启动器无效时返回配置错误，不会回退到无沙箱模式。
    #[cfg(unix)]
    pub fn configured(
        workdir: impl AsRef<Path>,
        shell: impl AsRef<Path>,
        sandbox: SandboxMode,
    ) -> Result<Self, Error> {
        let workdir = directory(workdir.as_ref()).map_err(Error::Config)?;
        // 保留符号链接名：sh 兼容模式和 BusyBox 等程序通过 argv[0] 决定行为。
        let shell = std::path::absolute(shell.as_ref())
            .map_err(|e| Error::Config(format!("shell 路径无效：{e}")))?;
        let metadata = shell
            .metadata()
            .map_err(|e| Error::Config(format!("shell 无法读取：{e}")))?;
        if !metadata.is_file() {
            return Err(Error::Config("shell 必须是可执行文件".into()));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(Error::Config("shell 没有执行权限".into()));
            }
        }
        let policy = sandbox::Policy::new(sandbox, &workdir).map_err(Error::Config)?;
        let access = match policy.permissions() {
            None => "宿主已显式关闭沙箱，命令使用宿主权限与原有环境。",
            Some(permissions) if permissions.network == NetworkAccess::Allowed => {
                "系统沙箱已启用，网络已由宿主开放；文件访问仅限工作区、系统运行时及宿主授权路径。"
            }
            Some(_) => "系统沙箱已启用，网络关闭；文件访问仅限工作区、系统运行时及宿主授权路径。",
        };
        let description = format!(
            "在当前对话中执行终端命令：exec 启动独立 shell，interact 读取增量输出或发送输入，stop 终止进程组，list 找回同权限终端。yield_time_ms 只控制本次等待；timeout_ms 控制命令寿命。跨轮进程保留，关闭会话清理。交互需 tty=true；默认 stdin 关闭。非零退出码表示命令失败，输出截断保留首尾。默认工作目录：{}。{access}权限不能通过工具参数修改，权限不同的进程不能复用。",
            workdir.display()
        );
        Ok(Self {
            workdir,
            shell,
            description,
            policy,
        })
    }

    #[cfg(unix)]
    async fn run(
        &self,
        args: TerminalInput,
        context: &ToolContext,
    ) -> Result<TerminalOutput, String> {
        use contract::DEFAULT_OUTPUT;
        args.validate()?;
        let manager = context.session.terminals();
        match args {
            TerminalInput::Exec {
                cmd,
                workdir,
                tty,
                yield_time_ms,
                max_output_chars,
                timeout_ms,
            } => {
                let cwd = match workdir {
                    Some(path) => directory(&self.workdir.join(path))?,
                    None => self.workdir.clone(),
                };
                context.execution.check().map_err(|e| e.to_string())?;
                let process = manager.spawn(
                    &self.shell,
                    &cwd,
                    &cmd,
                    tty,
                    timeout_ms.map(Duration::from_millis),
                    &self.policy,
                )?;
                let _interaction = process.interaction.lock().await;
                process
                    .state
                    .wait(Duration::from_millis(yield_time_ms))
                    .await;
                Ok(TerminalOutput::Observation(
                    process.state.take(max_output_chars),
                ))
            }
            TerminalInput::Interact {
                session_id,
                input,
                yield_time_ms,
                max_output_chars,
            } => manager
                .interact(
                    &session_id,
                    &input,
                    Duration::from_millis(yield_time_ms),
                    max_output_chars,
                    &self.policy,
                )
                .await
                .map(TerminalOutput::Observation),
            TerminalInput::Stop { session_id } => manager
                .stop(&session_id, DEFAULT_OUTPUT, &self.policy)
                .await
                .map(TerminalOutput::Observation),
            TerminalInput::List => manager
                .list(&self.policy)
                .map(|terminals| TerminalOutput::List { terminals }),
        }
    }
}

fn directory(path: &Path) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("工作目录不存在或无法访问：{e}"))?;
    if !path.is_dir() {
        return Err("workdir 必须是目录".into());
    }
    Ok(path)
}

#[async_trait]
impl Tool for TerminalTool {
    type Args = TerminalInput;
    type Output = TerminalOutput;
    fn name(&self) -> &str {
        "terminal"
    }
    fn description(&self) -> &str {
        &self.description
    }
    async fn execute(
        &self,
        args: Self::Args,
        context: ToolContext,
    ) -> Result<Self::Output, ToolError> {
        #[cfg(unix)]
        {
            context
                .execution
                .wait(self.run(args, &context))
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?
                .map_err(ToolError::Execution)
        }
        #[cfg(not(unix))]
        {
            let _ = (args, context, &self.workdir, &self.shell);
            Err(ToolError::Execution(
                "终端工具首版只支持 macOS/Linux".into(),
            ))
        }
    }
}

#[cfg(not(unix))]
#[derive(Default)]
pub(crate) struct Manager;
#[cfg(not(unix))]
impl Manager {
    pub(crate) async fn close(&self) -> Result<(), String> {
        Ok(())
    }
}
