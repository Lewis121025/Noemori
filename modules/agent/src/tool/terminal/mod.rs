//! 会话级终端工具：命令执行、PTY 交互、增量输出、显式停止与资源清理。

mod approval;
#[cfg(unix)]
mod network;
#[cfg(unix)]
pub(crate) use network::NetworkSession;
#[cfg(unix)]
pub use network::{
    TerminalNetworkApprovalDecision, TerminalNetworkApprovalRequest, TerminalNetworkApprover,
    TerminalNetworkConfig, TerminalNetworkDecision, TerminalNetworkObservation,
    TerminalNetworkPolicy, TerminalNetworkProtocol, TerminalNetworkRule, TerminalNetworkTarget,
    TerminalProxyListener, TerminalProxyListenerInfo, TerminalProxyProtocol, TerminalUpstreamProxy,
};
#[cfg(unix)]
mod command_policy;
#[cfg(unix)]
pub use command_policy::{
    TerminalCommandDecision, TerminalCommandEvaluation, TerminalCommandMatch,
    TerminalCommandPattern, TerminalCommandPolicy, TerminalCommandRule,
};
#[cfg(unix)]
mod backend;
mod buffer;
mod contract;
#[cfg(unix)]
mod fingerprint;
#[cfg(unix)]
mod rules;
#[cfg(unix)]
pub(crate) use rules::SessionApprovals;
#[cfg(unix)]
pub use rules::{
    TerminalApprovalRule, TerminalApprovalScope, TerminalApprovalStore, TerminalPermissionGrant,
    TerminalReadGrant,
};
#[cfg(unix)]
mod shell;
#[cfg(unix)]
mod snapshot;
#[cfg(unix)]
pub use shell::TerminalShellOptions;
#[cfg(unix)]
mod journal;
#[cfg(unix)]
mod sandbox;
#[cfg(unix)]
pub use sandbox::{NetworkAccess, SandboxConfig, SandboxEnvironment, SandboxMode, WorkspaceAccess};
#[cfg(unix)]
mod io;
#[cfg(unix)]
mod manager;
#[cfg(unix)]
mod process;
#[cfg(unix)]
mod subscription;
#[cfg(unix)]
mod worker;
#[cfg(unix)]
pub use subscription::TerminalSubscription;

pub use approval::{
    TerminalApprovalDecision, TerminalApprovalRequest, TerminalApprover, TerminalPermissionRequest,
};
pub use contract::{
    TerminalBytesPage, TerminalEvent, TerminalInfo, TerminalInput, TerminalLogLimits,
    TerminalObservation, TerminalOutput, TerminalOutputChunk, TerminalOutputPage, TerminalSize,
    TerminalStatus, TerminalStream, TerminalSummary,
};
#[cfg(unix)]
pub(crate) use manager::Manager;

use super::{Tool, ToolConcurrency, ToolContext, ToolError};
use crate::Error;
use async_trait::async_trait;
#[cfg(unix)]
use std::time::Duration;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// 无可变进程状态的工具配置；会话决定进程归属，注册表克隆不会混合不同对话。
///
/// 支持 macOS/Linux；默认仅工作区可写、网络关闭，宿主可显式调整权限。
/// 内置 ripgrep 随库分发并优先加入 PATH，不依赖宿主安装；初始化时校验可执行性。
/// 每次 exec 启动独立 shell，默认非登录；宿主可设置登录默认值并采集初始化快照。
/// 命令中的 cd、export 不会影响下一次 exec，也不会反向修改已采集的快照。
#[derive(Clone)]
pub struct TerminalTool {
    workdir: PathBuf,
    shell: PathBuf,
    description: String,
    approver: Option<Arc<dyn TerminalApprover>>,
    #[cfg(unix)]
    observer: Option<Arc<dyn TerminalObserver>>,
    #[cfg(unix)]
    policy: sandbox::Policy,
    #[cfg(unix)]
    shell_options: TerminalShellOptions,
    #[cfg(unix)]
    approval_store: Option<Arc<TerminalApprovalStore>>,
    #[cfg(unix)]
    command_policy: Option<TerminalCommandPolicy>,
    #[cfg(unix)]
    ingress: Arc<network::IngressRuntime>,
}

impl TerminalTool {
    /// 返回此工具已启动的宿主共享代理入口；读取状态不绑定端口，也不暴露进程凭据。
    #[cfg(unix)]
    pub fn proxy_listeners(&self) -> Vec<TerminalProxyListenerInfo> {
        self.ingress.status()
    }
    /// 安装宿主验证的命令规则；每次 exec 都先检查规则，再检查可复用许可和资源审批。
    /// 策略不能由模型参数修改，允许规则不会扩大默认沙箱权限。
    #[cfg(unix)]
    pub fn with_command_policy(mut self, policy: TerminalCommandPolicy) -> Self {
        if self.command_policy.is_none() {
            self.description.push_str("宿主已启用命令规则；禁止规则优先于审批和允许规则，简单复合命令逐条检查，复杂语法按完整 shell 调用审批。既有资源授权不能跳过逐次命令审批。");
        }
        self.command_policy = Some(policy);
        self
    }
    /// 接入宿主的持久规则库；批准前缀后先保存规则，再允许本次命令执行。
    /// # 错误
    /// 未启用系统沙箱、规则文件落入命令可写范围时返回配置错误，拒绝自授权路径。
    #[cfg(unix)]
    pub fn with_approval_store(mut self, store: Arc<TerminalApprovalStore>) -> Result<Self, Error> {
        self.validate_rule_store(&self.policy, &store)
            .map_err(Error::Config)?;
        if self.approval_store.is_none() {
            self.description.push_str("宿主已启用持久审批规则；每次仍用 permission_request 明确额外范围，匹配已批准范围与前缀时可复用许可。");
        }
        self.approval_store = Some(store);
        Ok(self)
    }

    #[cfg(unix)]
    fn validate_rule_store(
        &self,
        policy: &sandbox::Policy,
        store: &TerminalApprovalStore,
    ) -> Result<(), String> {
        let permissions = policy
            .permissions()
            .ok_or("持久审批规则库要求启用系统沙箱")?;
        if permissions
            .writable
            .iter()
            .any(|root| store.path().starts_with(root))
        {
            return Err(
                "命令不能获得审批规则文件的写权限，请把规则库移到工作区和可写授权范围之外".into(),
            );
        }
        Ok(())
    }
    /// 在当前权限内采集 Bash/Zsh 的交互式登录环境，并将快照设为后续默认登录环境。
    ///
    /// `home` 是初始化时的 HOME；Zsh 同时遵守宿主的 ZDOTDIR，已有配置文件须获读取授权。
    /// 快照保存用户变量、函数、别名及解析选项，后续命令继续使用自己的私有 HOME/TMPDIR。
    /// # 错误
    /// 登录模式被禁用、shell 不支持快照、配置未授权、采集失败/超预算/取消时返回错误并清理采集进程。
    #[cfg(unix)]
    pub async fn capture_shell_snapshot(
        mut self,
        home: impl AsRef<Path>,
        context: crate::ExecutionContext,
    ) -> Result<Self, Error> {
        let captured = snapshot::capture(&self, home.as_ref(), context).await?;
        self.policy = self.policy.with_snapshot(captured);
        self.shell_options.default_login = true;
        Ok(self)
    }
    /// 设置登录 shell 的默认行为及宿主许可；配置无效时不启动命令。
    ///
    /// # 错误
    /// 禁止登录模式却要求默认登录时返回配置错误。
    #[cfg(unix)]
    pub fn with_shell_options(mut self, options: TerminalShellOptions) -> Result<Self, Error> {
        if options.default_login && !options.allow_login {
            return Err(Error::Config(
                "禁止登录 shell 时不能默认使用登录模式".into(),
            ));
        }
        self.shell_options = options;
        Ok(self)
    }
    /// 安装宿主输出观察器；进程登记后、exec 等待前交付可回放的独立订阅。
    ///
    /// 观察器必须快速返回，由宿主自己的任务消费订阅；不改变模型结果和进程权限。
    #[cfg(unix)]
    pub fn with_observer(mut self, observer: Arc<dyn TerminalObserver>) -> Self {
        self.observer = Some(observer);
        self
    }
    /// 从指定原始字节位置订阅终端输出；创建订阅不消耗文本预览或其他读者的数据。
    ///
    /// `session` 必须拥有该终端，权限须与此工具相同；offset=0 可回放全部输出。
    /// # 错误
    /// 会话已关闭、标识未知或权限不一致时拒绝订阅；无效字节游标在首次 recv 返回错误。
    #[cfg(unix)]
    pub fn subscribe(
        &self,
        session: &crate::AgentSession,
        session_id: &str,
        offset: u64,
    ) -> Result<TerminalSubscription, Error> {
        session
            .terminals()
            .subscribe(session_id, offset, &self.policy)
            .map_err(Error::ToolInfrastructure)
    }

    /// 为宿主按原始字节游标读取日志，不消费模型增量文本；页预算为 1..=120000 字节。
    /// # 错误
    /// 页预算无效、会话关闭、记录失效、归属不符或日志 I/O 失败时返回错误。
    #[cfg(unix)]
    pub async fn read_bytes(
        &self,
        session: &crate::AgentSession,
        id: &str,
        offset: u64,
        limit: usize,
    ) -> Result<TerminalBytesPage, Error> {
        if !(1..=contract::MAX_OUTPUT).contains(&limit) {
            return Err(Error::Config("终端原始字节页预算必须为 1..=120000".into()));
        }
        session
            .terminals()
            .read_bytes(id, offset, limit, &self.policy)
            .await
            .map_err(Error::ToolInfrastructure)
    }

    /// 将宿主界面的输入直接送入已有终端，不等待或消费模型的增量输出。
    ///
    /// `session` 必须拥有终端且权限与此工具相同；`input` 保留原始字节，最多 16 KiB。
    /// `close_stdin` 在写入后发送管道 EOF，PTY 不支持半关闭；`execution` 约束等待输入的时间。
    /// 返回仅表示本次写入完成，输出由独立订阅读取；取消或失败后禁止自动重放输入。
    /// # 错误
    /// 会话关闭、归属不符、输入超预算、stdin 不可写、PTY 半关闭、取消或超时时返回错误。
    /// 写入期间失败可能已经发送部分字节；本方法不回滚或中断已运行的命令。
    #[cfg(unix)]
    pub async fn send_input(
        &self,
        session: &crate::AgentSession,
        session_id: &str,
        input: &[u8],
        close_stdin: bool,
        execution: crate::ExecutionContext,
    ) -> Result<(), Error> {
        execution.check()?;
        if input.len() > contract::MAX_INPUT_BYTES {
            return Err(Error::Config("宿主终端输入超过 16 KiB 预算".into()));
        }
        execution
            .wait(
                session
                    .terminals()
                    .send_input(session_id, input, close_stdin, &self.policy),
            )
            .await?
            .map_err(Error::ToolInfrastructure)
    }

    /// 为宿主界面排队停止已有终端，不等待退出或消费模型的增量输出。
    ///
    /// `session` 必须拥有终端，权限和环境快照须与此工具相同；返回请求后的当前状态。
    /// 返回状态仍可能为 Running，最终退出和清理结果由输出订阅或后续 list 交付。
    /// 重复停止已结束且未释放的终端返回其原状态，不重新执行命令。
    /// # 错误
    /// 会话关闭、标识未知或启动权限不一致时返回错误，不影响其他终端。
    #[cfg(unix)]
    pub fn request_stop(
        &self,
        session: &crate::AgentSession,
        session_id: &str,
    ) -> Result<TerminalInfo, Error> {
        session
            .terminals()
            .request_stop(session_id, &self.policy)
            .map_err(Error::ToolInfrastructure)
    }

    /// 安装宿主审批处理器；只处理显式权限申请，批准不会修改工具默认权限。
    ///
    /// `approver` 的决定只约束被审批的进程；返回可继续注册的工具，不执行命令。
    pub fn with_approver(mut self, approver: Arc<dyn TerminalApprover>) -> Self {
        if self.approver.replace(approver).is_none() {
            self.description.push_str("宿主已启用审批；可用 permission_request 提供原因并申请额外文件或网络权限，是否仅批准本次、在会话中复用或保存前缀规则由宿主决定。每次仍声明所需范围，批准不会改变默认沙箱。");
        }
        self
    }

    /// 使用宿主 SHELL（未设置时为 /bin/sh）创建工具并校验内置依赖，不执行用户命令。
    ///
    /// `workdir` 会解析为绝对目录；返回可注册的工具。
    /// # 错误
    /// 目录或 shell 无效、内置工具或沙箱启动器不可用、平台不支持时返回配置或能力错误。
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
    /// 路径、环境、内置工具或沙箱启动器无效、shell 不可执行或平台不支持时返回错误。
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
    /// 默认构造器使用受限模式；Disabled 保留宿主环境与系统权限，并在 PATH 前加入内置工具。
    /// # 错误
    /// 路径、授权、内置工具或受保护启动器无效时返回配置错误，不会回退到无沙箱模式。
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
            None => "宿主已显式关闭沙箱，命令使用宿主权限，PATH 优先使用内置工具。",
            Some(permissions) if permissions.network == NetworkAccess::Allowed => {
                "系统沙箱已启用，网络已由宿主开放；文件访问仅限工作区、系统运行时及宿主授权路径。"
            }
            Some(permissions) if matches!(permissions.network, NetworkAccess::Managed(_)) => {
                "系统沙箱已启用，网络只能经本终端专属代理访问已获准目标；未匹配的目标需宿主审批，文件和网络的原始直连权限不会因此开放。"
            }
            Some(_) => "系统沙箱已启用，网络关闭；文件访问仅限工作区、系统运行时及宿主授权路径。",
        };
        let description = format!(
            "在当前对话中执行终端命令：已内置 rg（ripgrep），文件内容搜索优先使用 rg，文件列表使用 rg --files；无匹配的退出码 1 不代表工具故障。exec 启动独立 shell，login 选择登录环境，省略时由宿主设置决定；宿主已采集快照时可复用初始化变量、函数和别名。interact 读取增量输出或发送输入，stop 终止进程组，list 找回同权限终端。read 用 UTF-8 字节游标重复读取完整日志，next_offset 用于续读且不消耗增量输出；read_bytes 用独立的原始字节游标回读，返回带 stdout/stderr/terminal 来源的 Base64 分片；write 无损发送 Base64 输入。release 释放已结束的终端及日志。默认磁盘日志预算为单命令 64 MiB、会话 256 MiB，宿主可配置或取消上限；预算包括记录元数据，超额明确失败并停止命令。yield_time_ms 只控制本次等待；timeout_ms 控制命令寿命。跨轮进程保留，关闭会话清理。非 PTY 输入需 stdin=true，close_stdin 可发送管道 EOF；PTY 自带输入并支持 size/resize，interrupt 发送 SIGINT。退出码按命令语义解释，输出截断保留首尾。默认工作目录：{}。{access}权限不能通过工具参数修改，权限不同的进程不能复用。",
            workdir.display()
        );
        Ok(Self {
            workdir,
            shell,
            description,
            approver: None,
            observer: None,
            policy,
            shell_options: TerminalShellOptions::default(),
            approval_store: None,
            command_policy: None,
            ingress: Arc::new(network::IngressRuntime::default()),
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
                login,
                workdir,
                tty,
                stdin,
                size,
                yield_time_ms,
                max_output_chars,
                timeout_ms,
                permission_request,
            } => {
                let login = login.unwrap_or(self.shell_options.default_login);
                if login && !self.shell_options.allow_login {
                    return Err("宿主已禁止登录 shell，命令未执行".into());
                }
                let cwd = match workdir {
                    Some(path) => directory(&self.workdir.join(path))?,
                    None => self.workdir.clone(),
                };
                let command_policy = self
                    .command_policy
                    .as_ref()
                    .map(|policy| policy.evaluate(&self.shell, login, &cmd))
                    .transpose()
                    .map_err(|error| error.to_string())?;
                if let Some(evaluation) = &command_policy
                    && evaluation.decision == Some(TerminalCommandDecision::Forbidden)
                {
                    let reasons: Vec<_> = evaluation
                        .matches
                        .iter()
                        .filter(|matched| matched.decision == TerminalCommandDecision::Forbidden)
                        .filter_map(|matched| matched.justification.as_deref())
                        .collect();
                    return Err(format!(
                        "宿主命令策略禁止执行：{}",
                        if reasons.is_empty() {
                            "命令命中禁止规则".into()
                        } else {
                            reasons.join("；")
                        }
                    ));
                }
                let prompt = command_policy.as_ref().is_some_and(|evaluation| {
                    evaluation.decision == Some(TerminalCommandDecision::Prompt)
                });
                let requested = permission_request.or_else(|| {
                    prompt.then(|| TerminalPermissionRequest {
                        reason: "宿主命令策略要求完整审批本次调用".into(),
                        readable_paths: vec![],
                        writable_paths: vec![],
                        network: false,
                    })
                });
                let granted = if let Some(permissions) = requested {
                    Some(
                        self.authorize(
                            TerminalApprovalRequest {
                                call_id: context.call_id.clone(),
                                command: cmd.clone(),
                                workdir: cwd.clone(),
                                tty,
                                stdin,
                                size,
                                shell: self.shell.clone(),
                                login,
                                environment_snapshot: if login {
                                    self.policy
                                        .snapshot()
                                        .map(|snapshot| snapshot.id.to_string())
                                } else {
                                    None
                                },
                                policy_fingerprint: self.policy.fingerprint(),
                                environment_fingerprint: if login {
                                    self.policy
                                        .snapshot()
                                        .map(|snapshot| snapshot.fingerprint.clone())
                                } else {
                                    None
                                },
                                timeout_ms,
                                permissions,
                                command_policy,
                            },
                            context,
                        )
                        .await?,
                    )
                } else {
                    None
                };
                context.execution.check().map_err(|e| e.to_string())?;
                let process = manager.spawn(
                    manager::Command {
                        shell: shell::Invocation {
                            initialization: if login {
                                self.policy
                                    .snapshot()
                                    .map_or(shell::Initialization::Login, |snapshot| {
                                        shell::Initialization::Snapshot(snapshot.path())
                                    })
                            } else {
                                shell::Initialization::Plain
                            },
                            ..shell::Invocation::plain(&self.shell, &cmd)
                        },
                        cwd: &cwd,
                        io: if tty {
                            backend::IoMode::Pty(size.unwrap_or_default())
                        } else {
                            backend::IoMode::Pipe { stdin }
                        },
                        timeout: timeout_ms.map(Duration::from_millis),
                        policy: granted.as_ref().unwrap_or(&self.policy),
                        network_session: context.session.networks(),
                        call_id: &context.call_id,
                        observer: self.observer.clone(),
                        ingress: &self.ingress,
                    },
                    &self.policy,
                )?;
                if let Some(observer) = &self.observer {
                    observer.started(
                        &context.call_id,
                        process.state.info(),
                        TerminalSubscription::new(&process.state, 0),
                    );
                }
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
                close_stdin,
                yield_time_ms,
                max_output_chars,
            } => manager
                .interact(
                    &session_id,
                    &input,
                    close_stdin,
                    Duration::from_millis(yield_time_ms),
                    max_output_chars,
                    &self.policy,
                )
                .await
                .map(TerminalOutput::Observation),
            TerminalInput::Write {
                session_id,
                data_base64,
                close_stdin,
                yield_time_ms,
                max_output_chars,
            } => {
                let bytes = contract::decode_input(&data_base64)?;
                manager
                    .write(
                        &session_id,
                        &bytes,
                        close_stdin,
                        Duration::from_millis(yield_time_ms),
                        max_output_chars,
                        &self.policy,
                    )
                    .await
                    .map(TerminalOutput::Observation)
            }
            TerminalInput::Stop { session_id } => manager
                .stop(&session_id, DEFAULT_OUTPUT, &self.policy)
                .await
                .map(TerminalOutput::Observation),
            TerminalInput::Read {
                session_id,
                offset,
                max_output_chars,
            } => manager
                .read(&session_id, offset, max_output_chars, &self.policy)
                .await
                .map(TerminalOutput::Page),
            TerminalInput::ReadBytes {
                session_id,
                offset,
                max_output_bytes,
            } => manager
                .read_bytes(&session_id, offset, max_output_bytes, &self.policy)
                .await
                .map(TerminalOutput::Bytes),
            TerminalInput::Release { session_id } => {
                manager.release(&session_id, &self.policy)?;
                Ok(TerminalOutput::Released {
                    session_id,
                    released: true,
                })
            }
            TerminalInput::Resize { session_id, size } => {
                manager.resize(&session_id, size, &self.policy).await?;
                Ok(TerminalOutput::Controlled {
                    session_id,
                    applied: true,
                })
            }
            TerminalInput::Interrupt { session_id } => {
                manager.interrupt(&session_id, &self.policy).await?;
                Ok(TerminalOutput::Controlled {
                    session_id,
                    applied: true,
                })
            }
            TerminalInput::List => manager
                .list(&self.policy)
                .map(|terminals| TerminalOutput::List { terminals }),
        }
    }

    #[cfg(unix)]
    async fn authorize(
        &self,
        mut request: TerminalApprovalRequest,
        context: &ToolContext,
    ) -> Result<sandbox::Policy, String> {
        let resource_request = !request.permissions.readable_paths.is_empty()
            || !request.permissions.writable_paths.is_empty()
            || request.permissions.network;
        let (policy, resolved) = if resource_request {
            self.policy.grant(&request.permissions)?
        } else {
            (self.policy.clone(), request.permissions.clone())
        };
        if let Some(store) = &self.approval_store {
            self.validate_rule_store(&policy, store)?;
        }
        request.permissions = resolved;
        let grant = TerminalPermissionGrant::from_request(&request.permissions)?;
        let approvals = context.session.approvals();
        let _gate = approvals.gate.lock().await;
        if approvals.closed.is_cancelled() {
            return Err("审批会话已关闭".into());
        }
        let owner = self.policy.identity();
        let must_prompt = request
            .command_policy
            .as_ref()
            .is_some_and(|evaluation| evaluation.decision == Some(TerminalCommandDecision::Prompt));
        if !must_prompt
            && (approvals.allows(&owner, &request, &grant)
                || self
                    .approval_store
                    .as_ref()
                    .is_some_and(|store| store.allows(&request, &grant)))
        {
            return Ok(policy);
        }
        let approver = self
            .approver
            .as_ref()
            .ok_or("宿主未提供审批处理器，命令或额外权限申请被拒绝")?;
        let decision = tokio::select! {
            biased;
            _ = approvals.closed.cancelled() => return Err("审批会话已关闭".into()),
            result = approver.approve(request.clone(), context.execution.clone()) => result?,
        };
        context
            .execution
            .check()
            .map_err(|error| error.to_string())?;
        if approvals.closed.is_cancelled() {
            return Err("审批会话已关闭".into());
        }
        if !resource_request
            && !matches!(
                decision,
                TerminalApprovalDecision::AllowOnce | TerminalApprovalDecision::Deny(_)
            )
        {
            return Err("命令规则要求逐次审批，没有额外资源申请时只能批准本次或拒绝".into());
        }
        match decision {
            TerminalApprovalDecision::AllowOnce => {}
            TerminalApprovalDecision::AllowForSession => approvals.grant(owner, grant)?,
            TerminalApprovalDecision::AllowPrefix { prefix } => {
                approvals.rule(owner, TerminalApprovalRule::new(prefix, &request, grant)?)?;
            }
            TerminalApprovalDecision::AllowPersistentPrefix { prefix } => {
                let store = self
                    .approval_store
                    .as_ref()
                    .ok_or("宿主未启用持久审批规则库，命令未执行")?;
                store
                    .insert(TerminalApprovalRule::new(prefix, &request, grant)?)
                    .map_err(|error| error.to_string())?;
            }
            TerminalApprovalDecision::Deny(reason) => {
                return Err(format!("宿主拒绝权限申请：{reason}"));
            }
        }
        Ok(policy)
    }
}

/// 宿主接收新进程的边界；即使模型工具调用仍在等待，也能持续推送输出与终态。
#[cfg(unix)]
pub trait TerminalObserver: Send + Sync + 'static {
    /// 关联实际调用和终端，将订阅交给宿主任务；此同步回调不得阻塞或执行长任务。
    fn started(&self, call_id: &str, process: TerminalInfo, output: TerminalSubscription);
    /// 接收目标连接和拒绝事件，供宿主展示；回调必须快速返回，不包含网络传输内容。
    fn network(&self, _call_id: &str, _event: TerminalNetworkObservation) {}
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
    fn concurrency(&self, args: &TerminalInput) -> ToolConcurrency {
        #[cfg(unix)]
        if matches!(
            args,
            TerminalInput::Read { .. } | TerminalInput::ReadBytes { .. }
        ) || (matches!(
            args,
            TerminalInput::Exec {
                permission_request: None,
                ..
            }
        ) && self.policy.permissions().is_some_and(|policy| {
            policy.writable.is_empty() && policy.network == NetworkAccess::Denied
        })) {
            return ToolConcurrency::Concurrent;
        }
        let _ = args;
        ToolConcurrency::Sequential
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
