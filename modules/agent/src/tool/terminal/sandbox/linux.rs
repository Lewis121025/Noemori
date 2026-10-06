use super::{NetworkAccess, Permissions};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

/// Linux 执行目标；权限描述与 shell 文本分离，命令只能位于 Bubblewrap 的参数终止符之后。
pub(super) struct Target<'a> {
    pub(super) shell: &'a Path,
    pub(super) cwd: &'a Path,
    pub(super) command: &'a str,
    pub(super) tty: bool,
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
    args.push("--tmpfs".into());
    args.push(protected.as_os_str().to_owned());
    bind(&mut args, "--bind", home, home);
    bind(&mut args, "--bind", temp, temp);
    args.extend(
        ["--remount-ro", "/", "--chdir"]
            .into_iter()
            .map(OsString::from),
    );
    args.push(target.cwd.as_os_str().to_owned());
    args.extend([
        OsString::from("--"),
        target.shell.as_os_str().to_owned(),
        "-c".into(),
        target.command.into(),
    ]);
    Ok((program, args))
}

fn bind(args: &mut Vec<OsString>, option: &str, source: &Path, destination: &Path) {
    args.extend([
        option.into(),
        source.as_os_str().to_owned(),
        destination.as_os_str().to_owned(),
    ]);
}
