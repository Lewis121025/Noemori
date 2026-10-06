//! 沙箱权限来自宿主；策略编译、受保护启动器及系统执行参数均不接受模型覆盖。
//!
//! 部署时将 noemori-terminal-sandbox 放在宿主程序旁，或用 launcher 指定路径。
//! macOS 使用系统 sandbox-exec；Linux 需要支持禁用嵌套 user namespace 的 Bubblewrap，
//! 以及允许无特权 user namespace 的内核配置，缺少任一条件都拒绝执行。

mod launch;
#[cfg(any(target_os = "linux", test))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod support;

pub(super) use launch::Launch;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use support::Support;

/// 终端命令的网络权限；允许联网也不会扩大文件访问范围。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NetworkAccess {
    /// 阻止与宿主及外部网络通信。
    #[default]
    Denied,
    /// 宿主显式授权网络，包括监听端口及访问本机服务。
    Allowed,
}

/// 宿主控制的沙箱授权；所有路径必须存在，且不能由模型工具参数修改。
#[derive(Clone, Debug, Default)]
pub struct SandboxConfig {
    /// 额外只读目录或文件；默认只读取系统运行时和工作区。
    pub readable_paths: Vec<PathBuf>,
    /// 额外可读写目录；工作区本身始终可读写，禁止根目录等可移动沙箱运行目录祖先的范围。
    pub writable_paths: Vec<PathBuf>,
    /// 默认禁用网络，宿主可显式开放。
    pub network: NetworkAccess,
    /// noemori-terminal-sandbox 可执行文件；省略时查找应用旁的同名程序。
    pub launcher: Option<PathBuf>,
}

/// 仅宿主可选择的执行模式；启用沙箱后任何初始化失败都不会自动降级。
#[derive(Clone, Debug)]
pub enum SandboxMode {
    /// 系统强制隔离，默认仅工作区可写、网络关闭。
    Restricted(SandboxConfig),
    /// 宿主明确授予完整权限；命令继承原有环境，不做系统隔离。
    Disabled,
}

impl Default for SandboxMode {
    fn default() -> Self {
        Self::Restricted(SandboxConfig::default())
    }
}

/// 可比较的权限快照；已运行进程只能通过相同授权的工具继续访问。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Permissions {
    pub(super) readable: Vec<PathBuf>,
    pub(super) writable: Vec<PathBuf>,
    pub(super) network: NetworkAccess,
}

/// 仅宿主显式关闭时为空；受限模式必须同时拥有权限快照和受保护启动器。
pub(super) struct Policy(Option<RestrictedPolicy>);

/// 权限与启动器共同构造、共同持有，禁止出现“启用沙箱但缺少启动器”的半初始化状态。
struct RestrictedPolicy {
    permissions: Permissions,
    support: Arc<Support>,
}

impl Policy {
    /// 绑定宿主授权与启动器；workspace 须为已解析符号链接的绝对目录，授权无效时返回配置原因。
    pub(super) fn new(mode: SandboxMode, workspace: &Path) -> Result<Self, String> {
        let SandboxMode::Restricted(config) = mode else {
            return Ok(Self(None));
        };
        if config.readable_paths.len() + config.writable_paths.len() > 64 {
            return Err("沙箱最多接受 64 个额外授权路径".into());
        }
        let mut writable = vec![workspace.to_owned()];
        for path in config.writable_paths {
            let path = canonical(&path)?;
            if !path.is_dir() {
                return Err("沙箱可写授权必须指向目录".into());
            }
            writable.push(path);
        }
        compact(&mut writable);
        let mut readable = runtime_paths();
        for path in config.readable_paths {
            readable.push(canonical(&path)?);
        }
        compact(&mut readable);
        readable.retain(|path| !writable.iter().any(|root| path.starts_with(root)));
        let support = Support::new(config.launcher)?;
        let parent = support
            .root
            .path()
            .parent()
            .ok_or("沙箱运行目录没有父目录")?;
        if writable.iter().any(|root| {
            (parent.starts_with(root) && root != parent) || root.starts_with(support.root.path())
        }) {
            // Seatbelt 按路径限制权限，不能允许命令移动受保护目录的祖先后从新路径访问启动器。
            return Err("沙箱可写范围包含受保护运行目录或其上层；请缩小授权范围，完整权限必须由宿主显式选择 Disabled".into());
        }
        Ok(Self(Some(RestrictedPolicy {
            permissions: Permissions {
                readable,
                writable,
                network: config.network,
            },
            support,
        })))
    }

    /// 仅提供只读快照供进程归属校验；调用方不能拆开或替换沙箱的启动资源。
    pub(super) fn permissions(&self) -> Option<&Permissions> {
        self.0.as_ref().map(|restricted| &restricted.permissions)
    }
}

impl RestrictedPolicy {
    fn validate_cwd(&self, cwd: &Path) -> Result<(), String> {
        let allowed = self
            .permissions
            .readable
            .iter()
            .chain(&self.permissions.writable)
            .any(|root| cwd.starts_with(root));
        if !allowed || cwd.starts_with(self.support.root.path()) {
            return Err("工作目录不在沙箱授权范围内；模型不能通过 workdir 扩大权限".into());
        }
        Ok(())
    }
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("沙箱授权路径必须是绝对路径".into());
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("沙箱授权路径无效：{e}"))?;
    let text = path.to_str().ok_or("沙箱路径必须能表示为 UTF-8")?;
    if text.len() > 8192 {
        return Err("沙箱路径过长".into());
    }
    Ok(path)
}

fn compact(paths: &mut Vec<PathBuf>) {
    paths.sort();
    paths.dedup();
    let mut minimal = Vec::<PathBuf>::new();
    for path in paths.drain(..) {
        if !minimal.iter().any(|root| path.starts_with(root)) {
            minimal.push(path);
        }
    }
    *paths = minimal;
}

fn runtime_paths() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let paths = [
        "/System",
        "/usr/bin",
        "/usr/sbin",
        "/usr/lib",
        "/usr/libexec",
        "/usr/share",
        "/usr/include",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/local/lib",
        "/usr/local/libexec",
        "/usr/local/share",
        "/usr/local/include",
        "/usr/local/opt",
        "/usr/local/Cellar",
        "/bin",
        "/sbin",
        "/Library/Apple",
        "/Library/Developer",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/opt/homebrew/lib",
        "/opt/homebrew/libexec",
        "/opt/homebrew/opt",
        "/opt/homebrew/Cellar",
        "/opt/homebrew/share",
        "/opt/homebrew/include",
        "/private/var/select/sh",
        "/private/var/select/developer_dir",
        "/private/var/db/xcode_select_link",
        "/private/var/db/dyld",
        "/private/var/db/timezone",
        "/private/etc/ssl",
        "/private/etc/localtime",
        "/private/etc/zshenv",
    ];
    #[cfg(not(target_os = "macos"))]
    let paths = [
        "/usr/bin",
        "/usr/sbin",
        "/usr/lib",
        "/usr/lib64",
        "/usr/libexec",
        "/usr/share",
        "/usr/include",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/local/lib",
        "/usr/local/libexec",
        "/usr/local/share",
        "/usr/local/include",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/etc/ld.so.cache",
        "/etc/ld.so.conf",
        "/etc/ssl",
        "/etc/alternatives",
        "/etc/localtime",
        "/etc/nsswitch.conf",
        "/etc/hosts",
        "/etc/resolv.conf",
    ];
    let paths = paths.into_iter().map(PathBuf::from);
    // macOS 工具会探测可选系统配置；不存在的配置应返回 ENOENT，不能被 EPERM 阻断回退。
    #[cfg(target_os = "macos")]
    {
        paths.collect()
    }
    // Linux bind mount 必须存在，并保留 /bin 等符号链接入口的目标位置。
    #[cfg(not(target_os = "macos"))]
    {
        paths.filter(|p| p.exists()).collect()
    }
}

#[cfg(test)]
#[path = "../../../../../../test/agent/terminal/unit/sandbox.rs"]
mod tests;
