use super::super::shell::Invocation;
use super::{NetworkAccess, Permissions};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

/// Linux 执行目标；权限描述与 shell 文本分离，命令只能位于 Bubblewrap 的参数终止符之后。
pub(super) struct Target<'a> {
    pub(super) shell: Invocation<'a>,
    pub(super) cwd: &'a Path,
    pub(super) tty: bool,
    pub(super) network: Option<Relay<'a>>,
}

/// 受保护的转发初始化材料必须共同挂载，不能只提供网关而缺少可信启动器或初始化环境。
#[derive(Clone, Copy)]
pub(super) struct Relay<'a> {
    pub(super) launcher: &'a Path,
    pub(super) configuration: &'a Path,
    pub(super) environment: &'a Path,
    pub(super) gateway: &'a Path,
}

pub(super) fn command(
    policy: &Permissions,
    protected: &Path,
    home: &Path,
    temp: &Path,
    target: &Target<'_>,
) -> Result<(PathBuf, Vec<OsString>), String> {
    let program = if Path::new("/usr/bin/bwrap").is_file() {
        PathBuf::from("/usr/bin/bwrap")
    } else {
        PathBuf::from("/bin/bwrap")
    };
    let mut args: Vec<OsString> = [
        "--unshare-user",
        "--unshare-ipc",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-uts",
        "--die-with-parent",
        "--cap-drop",
        "ALL",
        "--disable-userns",
        "--assert-userns-disabled",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    if policy.network == NetworkAccess::Allowed {
        args.push("--share-net".into());
    }
    // PTY 已由宿主单独分配，不与用户物理终端共享；管道模式另外建立终端会话阻止 TIOCSTI。
    if !target.tty {
        args.push("--new-session".into());
    }
    args.extend(["--tmpfs", "/tmp"].into_iter().map(OsString::from));
    for root in &policy.readable {
        bind(&mut args, "--ro-bind", root, root);
    }
    for root in &policy.writable {
        bind(&mut args, "--bind", root, root);
    }
    args.extend(
        ["--proc", "/proc", "--dev", "/dev"]
            .into_iter()
            .map(OsString::from),
    );
    // 即使工作区包含宿主临时目录，也不能看到其他命令的 HOME 或受保护启动器。
    // 受保护目录只允许按已知路径穿越，不能枚举启动器或其他命令的目录名。
    args.extend(["--perms", "0111"].into_iter().map(OsString::from));
    args.push("--tmpfs".into());
    args.push(protected.as_os_str().to_owned());
    // 遮蔽共享私有目录后，仅以只读挂载恢复经过宿主校验的内置工具。
    let bin = protected.join("bin");
    bind(&mut args, "--ro-bind", &bin, &bin);
    if let Some(snapshot) = target.shell.snapshot() {
        bind(&mut args, "--ro-bind", snapshot, snapshot);
    }
    if let Some(network) = target.network {
        for path in [
            network.environment,
            network.configuration,
            network.gateway,
            network.launcher,
        ] {
            bind(&mut args, "--ro-bind", path, path);
        }
    }
    bind(&mut args, "--bind", home, home);
    bind(&mut args, "--bind", temp, temp);
    // namespace 的覆盖层不是额外写授权；显式授权的子挂载仍保持各自的读写模式。
    if !policy
        .writable
        .iter()
        .any(|root| Path::new("/tmp").starts_with(root))
    {
        args.extend(["--remount-ro", "/tmp"].into_iter().map(OsString::from));
    }
    args.push("--remount-ro".into());
    args.push(protected.as_os_str().to_owned());
    args.extend(
        ["--remount-ro", "/", "--chdir"]
            .into_iter()
            .map(OsString::from),
    );
    args.push(target.cwd.as_os_str().to_owned());
    args.push("--".into());
    if let Some(network) = target.network {
        args.extend([
            network.launcher.as_os_str().to_owned(),
            "--network-init".into(),
            network.configuration.as_os_str().to_owned(),
            "--".into(),
        ]);
    }
    args.push(target.shell.path.as_os_str().to_owned());
    args.extend(target.shell.args_with_network(
        &bin,
        target.cwd,
        target.network.map(|network| network.environment),
    ));
    Ok((program, args))
}

fn bind(args: &mut Vec<OsString>, option: &str, source: &Path, destination: &Path) {
    args.extend([
        option.into(),
        source.as_os_str().to_owned(),
        destination.as_os_str().to_owned(),
    ]);
}
