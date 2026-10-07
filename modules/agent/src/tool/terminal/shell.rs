use std::{ffi::OsString, path::Path};

/// 宿主允许的 shell 启动语义；默认保持独立非登录 shell，模型只能在允许时选择登录。
#[derive(Clone, Copy, Debug)]
pub struct TerminalShellOptions {
    /// 是否允许 login=true；关闭时在启动和审批前拒绝该请求。
    pub allow_login: bool,
    /// exec 省略 login 时的模式；不能在 allow_login=false 时设为 true。
    pub default_login: bool,
}

impl Default for TerminalShellOptions {
    fn default() -> Self {
        Self {
            allow_login: true,
            default_login: false,
        }
    }
}

/// 初始化方式互斥，避免出现“非登录却附带快照”或“采集却没有配置 HOME”的状态。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Initialization<'a> {
    Plain,
    Login,
    Snapshot(&'a Path),
    Capture { home: &'a Path },
}

/// shell 参数始终独立传递；快照初始化脚本不与模型命令拼接。
#[derive(Clone, Copy)]
pub(super) struct Invocation<'a> {
    pub(super) path: &'a Path,
    pub(super) command: &'a str,
    pub(super) initialization: Initialization<'a>,
}

impl<'a> Invocation<'a> {
    pub(super) fn plain(path: &'a Path, command: &'a str) -> Self {
        Self {
            path,
            command,
            initialization: Initialization::Plain,
        }
    }

    /// 初始化之后重新绑定调用者目录；命令保留为独立参数，eval 前的空格防止它被解释为选项。
    pub(super) fn args(&self, bin: &Path, cwd: &Path) -> Vec<OsString> {
        self.args_with_network(bin, cwd, None)
    }

    pub(super) fn args_with_network(
        &self,
        bin: &Path,
        cwd: &Path,
        network: Option<&Path>,
    ) -> Vec<OsString> {
        // Zsh 的 command 不搜索内建命令；其他 POSIX shell 用 command 排除同名函数。
        let change_directory = if self.path.file_name() == Some(std::ffi::OsStr::new("zsh")) {
            "builtin cd"
        } else {
            "command cd"
        };
        if let Some(network) = network
            && !matches!(self.initialization, Initialization::Capture { .. })
        {
            let (snapshot, command_index, network_index) = match self.initialization {
                Initialization::Snapshot(path) => (Some(path), 4, 5),
                _ => (None, 3, 4),
            };
            let setup = if snapshot.is_some() {
                ". \"$2\" || exit; PATH=\"$3:$PATH\";"
            } else {
                "PATH=\"$2:$PATH\";"
            };
            let bootstrap = format!(
                "{change_directory} \"$1\" || exit; {setup} export PATH; __noemori_exec_command=${command_index}; . \"${network_index}\" || exit; shift {network_index}; eval \" $__noemori_exec_command\""
            );
            let mut args = vec![
                if self.initialization == Initialization::Login {
                    "-lc".into()
                } else {
                    "-c".into()
                },
                bootstrap.into(),
                self.path.as_os_str().to_owned(),
                cwd.as_os_str().to_owned(),
            ];
            if let Some(snapshot) = snapshot {
                args.push(snapshot.as_os_str().to_owned());
            }
            args.extend([
                bin.as_os_str().to_owned(),
                self.command.into(),
                network.as_os_str().to_owned(),
            ]);
            return args;
        }
        match self.initialization {
            Initialization::Capture { .. } => vec!["-ilc".into(), self.command.into()],
            Initialization::Snapshot(snapshot) => vec![
                "-c".into(),
                format!("{change_directory} \"$1\" || exit; . \"$2\" || exit; PATH=\"$3:$PATH\"; export PATH; __noemori_exec_command=$4; shift 4; eval \" $__noemori_exec_command\"").into(),
                self.path.as_os_str().to_owned(),
                cwd.as_os_str().to_owned(),
                snapshot.as_os_str().to_owned(),
                bin.as_os_str().to_owned(),
                self.command.into(),
            ],
            Initialization::Plain | Initialization::Login => vec![
                    if self.initialization == Initialization::Login { "-lc".into() } else { "-c".into() },
                    format!("{change_directory} \"$1\" || exit; PATH=\"$2:$PATH\"; export PATH; __noemori_exec_command=$3; shift 3; eval \" $__noemori_exec_command\"").into(),
                    self.path.as_os_str().to_owned(), cwd.as_os_str().to_owned(), bin.as_os_str().to_owned(), self.command.into(),
            ],
        }
    }

    pub(super) fn snapshot(&self) -> Option<&'a Path> {
        match self.initialization {
            Initialization::Snapshot(path) => Some(path),
            _ => None,
        }
    }

    pub(super) fn capture_home(&self) -> Option<&'a Path> {
        match self.initialization {
            Initialization::Capture { home } => Some(home),
            _ => None,
        }
    }
}
