use super::{Policy, support::Support};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
};

/// 两种终端后端共用同一启动计划；策略先于 shell 生效，子进程只能继承限制。
pub(in crate::tool::terminal) struct Launch {
    pub(in crate::tool::terminal) program: PathBuf,
    pub(in crate::tool::terminal) args: Vec<OsString>,
    pub(in crate::tool::terminal) environment: Option<BTreeMap<OsString, OsString>>,
    resources: Option<Resources>,
}

/// 每条命令独立的可写 HOME/TMPDIR；与不可写的启动器区域共享受保护父目录。
struct Resources {
    directory: tempfile::TempDir,
    _support: Arc<Support>,
}

impl Launch {
    pub(in crate::tool::terminal) fn new(
        policy: &Policy,
        shell: &Path,
        cwd: &Path,
        cmd: &str,
        tty: Option<&Path>,
    ) -> Result<Self, String> {
        let Some(restricted) = &policy.0 else {
            return Ok(Self {
                program: shell.to_owned(),
                args: vec!["-c".into(), cmd.into()],
                environment: None,
                resources: None,
            });
        };
        restricted.validate_cwd(cwd)?;
        let permissions = &restricted.permissions;
        let support = &restricted.support;
        let resources = Resources::new(support.clone())?;
        let home = resources.home();
        let temp = resources.temp();
        #[cfg(target_os = "macos")]
        let (program, args) = super::macos::command(
            permissions,
            support.root.path(),
            &home,
            &temp,
            shell,
            cmd,
            tty,
        )?;
        #[cfg(target_os = "linux")]
        let (program, args) = super::linux::command(
            permissions,
            support.root.path(),
            &home,
            &temp,
            &super::linux::Target {
                shell,
                cwd,
                command: cmd,
                tty: tty.is_some(),
            },
        )?;
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        return Err("系统不支持终端沙箱，已拒绝执行".into());
        if !program.is_file() {
            return Err(format!(
                "系统沙箱程序不存在：{}；命令未执行",
                program.display()
            ));
        }
        let mut launcher_args = Vec::new();
        #[cfg(target_os = "linux")]
        if permissions.network == super::NetworkAccess::Denied {
            launcher_args.push("--deny-network".into());
        }
        launcher_args.push(program.into_os_string());
        launcher_args.extend(args);
        Ok(Self {
            program: support.launcher.clone(),
            args: launcher_args,
            environment: Some(environment(shell, &home, &temp)),
            resources: Some(resources),
        })
    }

    pub(in crate::tool::terminal) fn cleanup(&mut self) -> Result<(), String> {
        if let Some(resources) = self.resources.take() {
            resources
                .directory
                .close()
                .map_err(|e| format!("沙箱临时文件清理失败：{e}"))?;
        }
        Ok(())
    }
}

impl Resources {
    fn new(support: Arc<Support>) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("command-")
            .tempdir_in(support.root.path())
            .map_err(|e| format!("沙箱私有目录创建失败：{e}"))?;
        let resources = Self {
            directory,
            _support: support,
        };
        for path in [resources.home(), resources.temp()] {
            std::fs::create_dir(path).map_err(|e| format!("沙箱目录准备失败：{e}"))?;
        }
        Ok(resources)
    }

    fn home(&self) -> PathBuf {
        self.directory.path().join("home")
    }

    fn temp(&self) -> PathBuf {
        self.directory.path().join("tmp")
    }
}

/// 只继承显示与区域设置；凭据、shell 启动脚本及宿主 HOME 不进入沙箱。
fn environment(shell: &Path, home: &Path, temp: &Path) -> BTreeMap<OsString, OsString> {
    let mut environment = BTreeMap::from([
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ("HOME".into(), home.as_os_str().to_owned()),
        (
            "XDG_CACHE_HOME".into(),
            home.join(".cache").into_os_string(),
        ),
        (
            "XDG_CONFIG_HOME".into(),
            home.join(".config").into_os_string(),
        ),
        (
            "XDG_DATA_HOME".into(),
            home.join(".local/share").into_os_string(),
        ),
        ("SHELL".into(), shell.as_os_str().to_owned()),
        ("TMPDIR".into(), temp.as_os_str().to_owned()),
    ]);
    for key in ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM"] {
        if let Some(value) = std::env::var_os(key) {
            environment.insert(key.into(), value);
        }
    }
    environment
}
