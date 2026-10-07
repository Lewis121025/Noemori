use super::{
    TerminalLogLimits, TerminalStatus, TerminalStream, TerminalTool,
    backend::IoMode,
    manager::Command,
    sandbox::{Policy, Root},
    shell::{Initialization, Invocation},
};
use crate::{AgentSession, Error, ExecutionContext};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;

/// 每个工具单独持有快照，不放进所有沙箱共享的 bin；文件及身份随最后一个使用者释放。
pub(super) struct Snapshot {
    pub(super) id: uuid::Uuid,
    pub(super) fingerprint: String,
    file: tempfile::TempPath,
    _runtime: Arc<Root>,
}

impl Snapshot {
    pub(super) fn path(&self) -> &Path {
        &self.file
    }

    fn save(runtime: Arc<Root>, script: &[u8]) -> Result<Arc<Self>, Error> {
        use std::os::unix::fs::PermissionsExt;
        let mut file = tempfile::Builder::new()
            .prefix("shell-snapshot-")
            .tempfile_in(runtime.path())
            .map_err(|e| Error::Config(format!("环境快照创建失败：{e}")))?;
        file.write_all(script)
            .map_err(|e| Error::Config(format!("环境快照写入失败：{e}")))?;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o400))
            .map_err(|e| Error::Config(format!("环境快照保护失败：{e}")))?;
        let mut hash = super::fingerprint::Fingerprint::new("noemori-shell-snapshot-v1");
        let runtime_name = runtime
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Error::Config("运行目录名称无效".into()))?;
        // 临时运行目录的随机名称不代表初始化内容发生变化；其余用户状态保持参与指纹。
        let needle = runtime_name.as_bytes();
        let mut position = 0;
        while let Some(index) = script[position..]
            .windows(needle.len())
            .position(|bytes| bytes == needle)
        {
            hash.bytes(&script[position..position + index]);
            hash.bytes(b"NOEMORI_RUNTIME");
            position += index + needle.len();
        }
        hash.bytes(&script[position..]);
        Ok(Arc::new(Self {
            id: uuid::Uuid::new_v4(),
            fingerprint: hash.finish(),
            file: file.into_temp_path(),
            _runtime: runtime,
        }))
    }
}

/// 只支持具备原生状态序列化能力的 Bash/Zsh；其他 shell 的登录执行仍可独立使用。
enum Kind {
    Bash,
    Zsh,
}

impl Kind {
    fn from_path(path: &Path) -> Result<Self, Error> {
        match path.file_name().and_then(|name| name.to_str()) {
            Some("bash") => Ok(Self::Bash),
            Some("zsh") => Ok(Self::Zsh),
            _ => Err(Error::Unsupported(
                "环境快照目前支持 Bash/Zsh，请使用对应的 shell 路径".into(),
            )),
        }
    }

    fn startup_files(&self, tool: &TerminalTool, home: &Path) -> Vec<PathBuf> {
        match self {
            Self::Bash => [".bash_profile", ".bash_login", ".profile"]
                .into_iter()
                .map(|name| home.join(name))
                .find(|path| path.exists())
                .into_iter()
                .collect(),
            Self::Zsh => {
                let startup = tool
                    .policy
                    .variable("ZDOTDIR")
                    .map(|value| tool.workdir.join(value))
                    .unwrap_or_else(|| home.to_owned());
                [".zshenv", ".zprofile", ".zshrc", ".zlogin"]
                    .into_iter()
                    .map(|name| startup.join(name))
                    .filter(|path| path.exists())
                    .collect()
            }
        }
    }

    fn script(&self) -> &'static str {
        match self {
            Self::Bash => BASH_CAPTURE,
            Self::Zsh => ZSH_CAPTURE,
        }
    }
}

/// 在调用者的截止时间内完成采集与资源回收；只有完整协议结果才能保存成快照。
pub(super) async fn capture(
    tool: &TerminalTool,
    home: &Path,
    context: ExecutionContext,
) -> Result<Arc<Snapshot>, Error> {
    context.check()?;
    if !tool.shell_options.allow_login {
        return Err(Error::Config(
            "宿主已禁止登录 shell，不能采集登录环境快照".into(),
        ));
    }
    let kind = Kind::from_path(&tool.shell)?;
    let home = super::directory(home).map_err(Error::Config)?;
    validate_startup_access(&tool.policy, &kind.startup_files(tool, &home))?;
    let marker = uuid::Uuid::new_v4().simple().to_string();
    let begin = format!("NOEMORI_SNAPSHOT_BEGIN_{marker}");
    let end = format!("NOEMORI_SNAPSHOT_END_{marker}");
    let command = format!(
        "builtin printf '\\n{begin}\\n'\n__noemori_capture_managed={}\n{}\nbuiltin printf '\\n{end}\\n'",
        u8::from(matches!(
            tool.policy
                .permissions()
                .map(|permissions| &permissions.network),
            Some(super::NetworkAccess::Managed(_))
        )),
        kind.script()
    );
    let session = AgentSession::with_terminal_log_limits(TerminalLogLimits {
        process_bytes: Some(4 * 1024 * 1024),
        session_bytes: Some(4 * 1024 * 1024),
    })?;
    let result = context
        .wait(read_capture(tool, &session, &home, &command, &context))
        .await
        .and_then(|result| result);
    let cleanup = session.close().await;
    let raw = result?;
    cleanup?;
    let script = extract_script(&raw, begin.as_bytes(), end.as_bytes())?;
    context.check()?;
    let snapshot = Snapshot::save(tool.policy.runtime(), &script)?;
    context.check()?;
    Ok(snapshot)
}

fn validate_startup_access(policy: &Policy, files: &[PathBuf]) -> Result<(), Error> {
    let Some(permissions) = policy.permissions() else {
        return Ok(());
    };
    for path in files {
        let resolved = path
            .canonicalize()
            .map_err(|e| Error::Config(format!("启动配置路径无效：{e}")))?;
        if !permissions
            .readable
            .iter()
            .chain(&permissions.writable)
            .any(|root| resolved.starts_with(root))
        {
            return Err(Error::Config(format!(
                "启动配置未获得读取授权：{}",
                path.display()
            )));
        }
    }
    Ok(())
}

async fn read_capture(
    tool: &TerminalTool,
    session: &AgentSession,
    home: &Path,
    command: &str,
    context: &ExecutionContext,
) -> Result<Vec<u8>, Error> {
    let timeout = context
        .deadline
        .saturating_duration_since(tokio::time::Instant::now());
    let process = session
        .terminals()
        .spawn(
            Command {
                shell: Invocation {
                    path: &tool.shell,
                    command,
                    initialization: Initialization::Capture { home },
                },
                cwd: &tool.workdir,
                io: IoMode::Pty(Default::default()),
                timeout: Some(timeout),
                policy: &tool.policy,
                network_session: session.networks(),
                call_id: "shell-snapshot",
                observer: tool.observer.clone(),
                ingress: &tool.ingress,
            },
            &tool.policy,
        )
        .map_err(Error::ToolInfrastructure)?;
    process.state.wait(timeout).await;
    let info = process.state.info();
    if info.status != TerminalStatus::Exited || info.exit_code != Some(0) {
        return Err(Error::Config(format!(
            "登录环境采集未成功：{info:?}；{}",
            process.state.take(4096).output
        )));
    }
    let mut raw = Vec::new();
    let mut offset = 0;
    loop {
        let page = process
            .state
            .read_bytes(offset, 120000)
            .await
            .map_err(Error::ToolInfrastructure)?;
        if page.total_bytes > (MAX_SNAPSHOT_BYTES + 128 * 1024) as u64 {
            return Err(Error::Config(
                "登录环境采集超过 1 MiB 快照与 128 KiB 启动输出预算".into(),
            ));
        }
        for chunk in page.chunks {
            if chunk.stream == TerminalStream::Stdout {
                raw.extend(STANDARD.decode(chunk.data_base64).map_err(|e| {
                    Error::ToolInfrastructure(format!("环境采集输出编码无效：{e}"))
                })?);
            }
        }
        offset = page.next_offset;
        if !page.has_more {
            return Ok(raw);
        }
    }
}

fn extract_script(raw: &[u8], begin: &[u8], end: &[u8]) -> Result<Vec<u8>, Error> {
    let mut position = 0;
    let mut start = None;
    for line in raw.split_inclusive(|byte| *byte == b'\n') {
        let content = line.strip_suffix(b"\n").unwrap_or(line);
        if content == begin {
            start = Some(position + line.len());
        }
        if content == end {
            let start = start.ok_or_else(|| Error::Config("环境快照缺少开始标识".into()))?;
            let script = &raw[start..position];
            if script.len() > MAX_SNAPSHOT_BYTES {
                return Err(Error::Config("环境快照超过 1 MiB 预算".into()));
            }
            return Ok(script.to_vec());
        }
        position += line.len();
    }
    Err(Error::Config(
        "登录 shell 在完成环境快照前退出，缺少完整快照标识".into(),
    ))
}

// 先恢复影响语法解析的选项，再定义函数；登录身份、终端编辑与作业控制由新进程决定。
// 排除系统运行变量和私有目录；用户变量保留属性，使函数依赖的非导出状态和常量也能恢复。
// Bash 的别名表由 alias 单独恢复，避免定义函数前展开同名别名；命令路径缓存由新进程重建。
const BASH_CAPTURE: &str = r#"
builtin printf '%s\n' 'builtin unalias -a'
builtin set +o | while IFS=' ' read -r __noemori_capture_builtin __noemori_capture_flag __noemori_capture_option; do
    case "$__noemori_capture_option" in monitor|notify|ignoreeof|history|histexpand|emacs|vi|noexec|onecmd|privileged) continue ;; esac
    builtin printf 'builtin set %s %s\n' "$__noemori_capture_flag" "$__noemori_capture_option"
done
builtin shopt -p | while IFS=' ' read -r __noemori_capture_builtin __noemori_capture_flag __noemori_capture_option; do
    case "$__noemori_capture_option" in login_shell|restricted_shell) continue ;; esac
    builtin printf 'builtin shopt %s %s\n' "$__noemori_capture_flag" "$__noemori_capture_option"
done
builtin compgen -v | while IFS= read -r __noemori_capture_name; do
    case "$__noemori_capture_name" in ''|[0-9]*|*[!a-zA-Z0-9_]*) continue ;; esac
    if [ "$__noemori_capture_managed" = 1 ]; then
        case "$__noemori_capture_name" in HTTP_PROXY|http_proxy|HTTPS_PROXY|https_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy) continue ;; esac
    fi
    case "$__noemori_capture_name" in
        HOME|TMPDIR|SHELL|PWD|OLDPWD|SHLVL|_|BASH|BASHPID|BASHOPTS|BASH_VERSINFO|SHELLOPTS|EUID|UID|PPID|BASH_ALIASES|BASH_CMDS|BASH_ARGC|BASH_ARGV|BASH_ARGV0|BASH_COMMAND|BASH_EXECUTION_STRING|BASH_LINENO|BASH_SOURCE|BASH_SUBSHELL|DIRSTACK|FUNCNAME|GROUPS|LINENO|SECONDS|RANDOM|SRANDOM|EPOCHREALTIME|EPOCHSECONDS|HISTCMD|OPTIND|OPTARG|XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|__noemori_capture_*) continue ;;
    esac
    if [ "$__noemori_capture_name" = PATH ]; then
        builtin printf 'export PATH=%q\n' "$PATH"
        continue
    fi
    __noemori_capture_decl=$(builtin declare -p "$__noemori_capture_name")
    builtin printf '%s\n' "$__noemori_capture_decl"
done
builtin declare -f
builtin alias -p
"#;

const ZSH_CAPTURE: &str = r#"
builtin printf '%s\n' 'builtin unalias -a'
for __noemori_capture_option in ${(ok)options}; do
    case "$__noemori_capture_option" in interactive|login|privileged|restricted|shinstdin|singlecommand|zle|monitor|exec) continue ;; esac
    if [[ ${options[$__noemori_capture_option]} = on ]]; then
        builtin printf 'builtin setopt %s\n' "$__noemori_capture_option"
    else
        builtin printf 'builtin unsetopt %s\n' "$__noemori_capture_option"
    fi
done
for __noemori_capture_name in ${(k)parameters}; do
    case "$__noemori_capture_name" in ''|[0-9]*|*[!a-zA-Z0-9_]*) continue ;; esac
    if [[ $__noemori_capture_managed = 1 ]]; then
        case "$__noemori_capture_name" in HTTP_PROXY|http_proxy|HTTPS_PROXY|https_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy) continue ;; esac
    fi
    case "$__noemori_capture_name" in
        HOME|TMPDIR|SHELL|PWD|OLDPWD|SHLVL|_|XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|__noemori_capture_*) continue ;;
    esac
    __noemori_capture_attributes=${parameters[$__noemori_capture_name]}
    case "$__noemori_capture_attributes" in *special*) continue ;; esac
    builtin typeset -p "$__noemori_capture_name"
done
builtin printf 'export PATH=%q\n' "$PATH"
builtin typeset -p fpath
builtin typeset -f
builtin alias -L
"#;
