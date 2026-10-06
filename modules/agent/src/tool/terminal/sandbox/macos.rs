use super::{NetworkAccess, Permissions};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    path::{Path, PathBuf},
};

pub(super) fn command(
    policy: &Permissions,
    protected: &Path,
    home: &Path,
    temp: &Path,
    shell: &Path,
    cmd: &str,
    tty: Option<&Path>,
) -> Result<(PathBuf, Vec<OsString>), String> {
    let protected = quote(protected)?;
    let mut profile = String::from(
        "(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n(allow signal (target same-sandbox))\n(allow sysctl-read)\n(allow file-read* (literal \"/\"))\n",
    );
    // realpath/readlink 需要沿途元数据；仅放行祖先本身，不授予列目录或读取其他文件的权限。
    let mut ancestors = BTreeSet::from([
        PathBuf::from("/var"),
        PathBuf::from("/tmp"),
        PathBuf::from("/etc"),
    ]);
    for root in policy
        .readable
        .iter()
        .chain(&policy.writable)
        .map(PathBuf::as_path)
        .chain([home, temp])
    {
        ancestors.extend(root.ancestors().skip(1).map(Path::to_owned));
    }
    for ancestor in ancestors {
        profile.push_str(&format!(
            "(allow file-read-metadata (literal {}))\n",
            quote(&ancestor)?
        ));
    }
    for root in &policy.readable {
        grant(
            &mut profile,
            "file-read* file-map-executable",
            root,
            &protected,
        )?;
    }
    for root in &policy.writable {
        grant(
            &mut profile,
            "file-read* file-write* file-map-executable",
            root,
            &protected,
        )?;
    }
    for root in [home, temp] {
        profile.push_str(&format!(
            "(allow file-read* file-write* file-map-executable (subpath {}))\n",
            quote(root)?
        ));
    }
    profile.push_str("(allow file-read* file-write* (literal \"/dev/null\"))\n(allow file-read* (literal \"/dev/random\") (literal \"/dev/urandom\"))\n");
    if let Some(tty) = tty {
        profile.push_str(&format!(
            "(allow file-read* file-write* file-ioctl (literal {}) (literal \"/dev/tty\"))\n",
            quote(tty)?
        ));
    }
    if policy.network == NetworkAccess::Allowed {
        profile.push_str("(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6))\n(allow network-outbound (remote ip \"*:*\"))\n(allow network-inbound (local ip \"*:*\"))\n(allow network-bind (local ip \"*:*\"))\n(allow mach-lookup (global-name \"com.apple.mDNSResponder\") (global-name \"com.apple.SystemConfiguration.configd\"))\n(allow network-outbound (remote unix-socket (literal \"/private/var/run/mDNSResponder\")))\n");
    }
    if profile.len() > 64 * 1024 {
        return Err("沙箱配置超过系统启动参数预算".into());
    }
    Ok((
        "/usr/bin/sandbox-exec".into(),
        vec![
            "-p".into(),
            profile.into(),
            "--".into(),
            shell.as_os_str().to_owned(),
            "-c".into(),
            cmd.into(),
        ],
    ))
}

fn grant(profile: &mut String, actions: &str, path: &Path, protected: &str) -> Result<(), String> {
    let filter = if path.is_dir() { "subpath" } else { "literal" };
    profile.push_str(&format!(
        "(allow {actions} (require-all ({filter} {}) (require-not (subpath {protected}))))\n",
        quote(path)?
    ));
    Ok(())
}

fn quote(path: &Path) -> Result<String, String> {
    // Scheme 字符串只接受可打印路径；拒绝控制字符，避免把路径解释为策略表达式。
    let text = path.to_str().ok_or("沙箱路径不是 UTF-8")?;
    if text.chars().any(char::is_control) {
        return Err("沙箱路径不能包含控制字符".into());
    }
    Ok(format!(
        "\"{}\"",
        text.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
