use super::super::shell::Invocation;
use super::{NetworkAccess, Permissions};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    path::{Path, PathBuf},
};

/// 执行目标及进程专属网络资源共同构造；模型不能分别替换代理端口或初始化文件。
pub(super) struct Target<'a> {
    pub(super) shell: Invocation<'a>,
    pub(super) cwd: &'a Path,
    pub(super) tty: Option<&'a Path>,
    pub(super) network: Option<&'a super::super::network::Gateway>,
}

pub(super) fn command(
    policy: &Permissions,
    protected: &Path,
    home: &Path,
    temp: &Path,
    target: &Target<'_>,
) -> Result<(PathBuf, Vec<OsString>), String> {
    let Target {
        shell,
        cwd,
        tty,
        network,
    } = *target;
    let executable_directory = protected.join("bin");
    let bin = quote(&executable_directory)?;
    let protected = quote(protected)?;
    let mut profile = String::from(
        "(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n(allow signal (target same-sandbox))\n(allow sysctl-read)\n(allow file-read* (literal \"/\"))\n",
    );
    // 只开放内置工具子目录，其他命令的 HOME 和沙箱启动器仍不可见、不可写。
    profile.push_str(&format!("(allow file-read-metadata (literal {protected}))\n(allow file-read* file-map-executable (subpath {bin}))\n"));
    if let Some(snapshot) = shell.snapshot() {
        profile.push_str(&format!(
            "(allow file-read* (literal {}))\n",
            quote(snapshot)?
        ));
    }
    if let Some(network) = network {
        profile.push_str(&format!(
            "(allow file-read* (literal {}))\n",
            quote(network.environment())?
        ));
    }
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
    if let NetworkAccess::Managed(network) = &policy.network {
        for (path, decision) in &network.unix().rules {
            if *decision == super::super::TerminalNetworkDecision::Allow {
                ancestors.extend(path.ancestors().map(Path::to_owned));
            }
        }
        for link in &network.unix().symlinks {
            ancestors.extend(link.ancestors().map(Path::to_owned));
        }
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
    if let Some(network) = network {
        profile.push_str(&format!("(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6))\n(allow network-outbound (remote tcp \"localhost:{}\"))\n",network.port()));
        profile.push_str(&format!("(allow network-outbound (remote udp \"localhost:{}\"))\n(allow network-inbound (remote udp \"localhost:{}\"))\n(allow network-bind (local udp \"localhost:*\"))\n",network.port(),network.port()));
    }
    if let NetworkAccess::Managed(network) = &policy.network {
        unix_sockets(&mut profile, network, &[home, temp])?;
    }
    if profile.len() > 64 * 1024 {
        return Err("沙箱配置超过系统启动参数预算".into());
    }
    let mut args = vec![
        "-p".into(),
        profile.into(),
        "--".into(),
        shell.path.as_os_str().to_owned(),
    ];
    args.extend(shell.args_with_network(
        &executable_directory,
        cwd,
        network.map(|network| network.environment()),
    ));
    Ok(("/usr/bin/sandbox-exec".into(), args))
}

fn unix_sockets(
    profile: &mut String,
    policy: &super::super::TerminalNetworkPolicy,
    private_paths: &[&Path],
) -> Result<(), String> {
    let config = policy.config();
    let allowed: Vec<_> = policy
        .unix()
        .rules
        .iter()
        .filter(|(_, decision)| **decision == super::super::TerminalNetworkDecision::Allow)
        .map(|(path, _)| quote(path))
        .collect::<Result<_, _>>()?;
    if !config.dangerously_allow_all_unix_sockets && allowed.is_empty() {
        return Ok(());
    }
    profile.push_str("(allow system-socket (socket-domain AF_UNIX))\n");
    // 数据报客户端需要具名返回地址；仅开放本进程私有目录，不把目标授权变成工作区监听权限。
    for path in private_paths {
        profile.push_str(&format!(
            "(allow network-bind (local unix-socket (subpath {})))\n",
            quote(path)?
        ));
    }
    for path in allowed {
        profile.push_str(&format!(
            "(allow network-outbound network-inbound (remote unix-socket (literal {path})))\n"
        ));
    }
    if config.dangerously_allow_all_unix_sockets {
        profile.push_str("(allow network-outbound network-inbound (remote unix-socket))\n");
        profile.push_str("(allow file-read* (vnode-type SYMLINK))\n");
    } else {
        for link in &policy.unix().symlinks {
            profile.push_str(&format!(
                "(allow file-read* (require-all (literal {}) (vnode-type SYMLINK)))\n",
                quote(link)?
            ));
        }
    }
    // Seatbelt 的显式 deny 覆盖 allow，避免放开其他目标时绕过已配置的拒绝。
    for (path, decision) in &policy.unix().rules {
        if *decision == super::super::TerminalNetworkDecision::Deny {
            profile.push_str(&format!(
                "(deny network-outbound network-inbound (remote unix-socket (literal {})))\n",
                quote(path)?
            ));
        }
    }
    Ok(())
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
