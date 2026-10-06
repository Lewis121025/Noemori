use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};

static ROOT: Mutex<Weak<Root>> = Mutex::new(Weak::new());

/// 同一宿主的沙箱都排除此目录；最后一个工具和后台进程释放后自动删除。
pub(super) struct Root {
    directory: Option<tempfile::TempDir>,
    path: PathBuf,
    launchers: Mutex<BTreeMap<PathBuf, PathBuf>>,
}

impl Root {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

/// 将宿主选择的启动器复制到沙箱不可写的位置，工作区内的构建产物不能在启动之间被替换。
pub(super) struct Support {
    pub(super) root: Arc<Root>,
    pub(super) launcher: PathBuf,
}

impl Support {
    pub(super) fn new(launcher: Option<PathBuf>) -> Result<Arc<Self>, String> {
        let launcher = match launcher {
            Some(path) => path,
            None => default_launcher()?,
        };
        let launcher = launcher.canonicalize().map_err(|e| format!("沙箱启动器不可用：{e}；请构建并安装 noemori-terminal-sandbox，或由宿主指定 launcher 路径"))?;
        if !launcher.is_file() {
            return Err("沙箱启动器必须是可执行文件".into());
        }
        let mut cached = ROOT.lock().expect("沙箱目录锁被污染");
        let root = match cached.upgrade() {
            Some(root) => root,
            None => {
                let directory = tempfile::Builder::new()
                    .prefix("noemori-sandbox-")
                    .tempdir()
                    .map_err(|e| format!("沙箱运行目录创建失败：{e}"))?;
                let path = directory
                    .path()
                    .canonicalize()
                    .map_err(|e| format!("沙箱运行目录解析失败：{e}"))?;
                let root = Arc::new(Root {
                    directory: Some(directory),
                    path,
                    launchers: Mutex::new(BTreeMap::new()),
                });
                *cached = Arc::downgrade(&root);
                root
            }
        };
        let target = {
            let mut launchers = root.launchers.lock().expect("沙箱启动器锁被污染");
            if let Some(path) = launchers.get(&launcher) {
                path.clone()
            } else {
                let path = root.path().join(format!("launcher-{}", launchers.len()));
                std::fs::copy(&launcher, &path)
                    .map_err(|e| format!("沙箱启动器保护副本创建失败：{e}"))?;
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o500))
                    .map_err(|e| format!("沙箱启动器权限设置失败：{e}"))?;
                launchers.insert(launcher, path.clone());
                path
            }
        };
        Ok(Arc::new(Self {
            root,
            launcher: target,
        }))
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.take()
            && let Err(error) = directory.close()
        {
            eprintln!("沙箱运行目录清理失败：{error}");
        }
    }
}

fn default_launcher() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| format!("无法定位沙箱启动器：{e}"))?;
    let directory = executable.parent().ok_or("应用没有可执行目录")?;
    let sibling = directory.join("noemori-terminal-sandbox");
    if sibling.is_file() {
        return Ok(sibling);
    }
    // Cargo 将集成测试和示例放在 deps/examples 中，二进制目标放在其父目录。
    if matches!(
        directory.file_name().and_then(|n| n.to_str()),
        Some("deps" | "examples")
    ) {
        return Ok(directory
            .parent()
            .ok_or("Cargo 输出目录无效")?
            .join("noemori-terminal-sandbox"));
    }
    Ok(sibling)
}
