use super::super::shell::Invocation;
use super::Policy;
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
    // 无沙箱进程也可能跨轮运行，必须持有内置工具直到进程退出。
    _runtime: Arc<super::support::Root>,
    // fork 成功不代表 shell 已读取初始化文件；后台命令必须独立持有快照直到退出。
    _snapshot: Option<Arc<super::super::snapshot::Snapshot>>,
    network: Option<super::super::network::Gateway>,
}

/// 每条命令独立的可写 HOME/TMPDIR；与不可写的启动器区域共享受保护父目录。
struct Resources {
    directory: tempfile::TempDir,
}

impl Launch {
    pub(in crate::tool::terminal) fn new(
        policy: &Policy,
        shell: Invocation<'_>,
        cwd: &Path,
        tty: Option<&Path>,
        network: Option<&super::super::network::ProcessNetwork>,
    ) -> Result<Self, String> {
        let Some(restricted) = &policy.restricted else {
            let mut environment: BTreeMap<_, _> = std::env::vars_os().collect();
            let inherited = std::env::var_os("PATH").unwrap_or_default();
            environment.insert(
                "PATH".into(),
                search_path(&policy.runtime.bin(), &inherited)?,
            );
            if let Some(home) = shell.capture_home() {
                environment.insert("HOME".into(), home.as_os_str().to_owned());
            }
            let resources = if shell.snapshot().is_some() {
                Some(Resources::new(&policy.runtime)?)
            } else {
                None
            };
            if let Some(resources) = &resources {
                disable_reinitialization(&mut environment, &shell, &resources.home());
            }
            return Ok(Self {
                program: shell.path.to_owned(),
                args: shell.args(&policy.runtime.bin(), cwd),
                environment: Some(environment),
                resources,
                _runtime: policy.runtime.clone(),
                _snapshot: shell.snapshot().and_then(|_| policy.snapshot.clone()),
                network: None,
            });
        };
        restricted.validate_cwd(cwd)?;
        let permissions = &restricted.permissions;
        let support = &restricted.support;
        let resources = Resources::new(&policy.runtime)?;
        let home = resources.home();
        let temp = resources.temp();
        let gateway = if let super::NetworkAccess::Managed(policy) = &permissions.network {
            Some(super::super::network::Gateway::start(
                policy.clone(),
                network.ok_or("受控网络启动缺少进程和会话身份")?.clone(),
                resources.directory.path(),
            )?)
        } else {
            None
        };
        #[cfg(target_os = "macos")]
        let (program, args) = super::macos::command(
            permissions,
            support.root.path(),
            &home,
            &temp,
            &super::macos::Target {
                shell,
                cwd,
                tty,
                network: gateway.as_ref(),
            },
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
                tty: tty.is_some(),
                network: gateway.as_ref().map(|gateway| super::linux::Relay {
                    launcher: support.launcher.as_path(),
                    configuration: gateway.configuration(),
                    environment: gateway.environment(),
                    gateway: gateway.socket(),
                }),
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
        let mut configured_environment = environment(
            shell.path,
            shell.capture_home().unwrap_or(&home),
            &temp,
            &policy.runtime.bin(),
            &permissions.environment,
        )?;
        disable_reinitialization(&mut configured_environment, &shell, &home);
        if let Some(gateway) = &gateway {
            configured_environment.extend(gateway.variables());
        }
        Ok(Self {
            program: support.launcher.clone(),
            args: launcher_args,
            environment: Some(configured_environment),
            resources: Some(resources),
            _runtime: policy.runtime.clone(),
            _snapshot: shell.snapshot().and_then(|_| policy.snapshot.clone()),
            network: gateway,
        })
    }

    pub(in crate::tool::terminal) fn cleanup(&mut self) -> Result<(), String> {
        self.network.take();
        self._snapshot.take();
        if let Some(resources) = self.resources.take() {
            resources
                .directory
                .close()
                .map_err(|e| format!("沙箱临时文件清理失败：{e}"))?;
        }
        Ok(())
    }

    pub(in crate::tool::terminal) fn cancel_network(&self) {
        if let Some(network) = &self.network {
            network.cancel();
        }
    }
    pub(in crate::tool::terminal) async fn close_network(&mut self) -> Result<(), String> {
        if let Some(network) = &mut self.network {
            network.close().await?;
        }
        Ok(())
    }
}

/// 缓存命令在恢复快照前不再加载启动文件；恢复后的用户环境仍可供显式子 shell 使用。
fn disable_reinitialization(
    environment: &mut BTreeMap<OsString, OsString>,
    shell: &Invocation<'_>,
    startup: &Path,
) {
    if shell.snapshot().is_none() {
        return;
    }
    environment.remove(std::ffi::OsStr::new("BASH_ENV"));
    environment.remove(std::ffi::OsStr::new("ENV"));
    if shell.path.file_name() == Some(std::ffi::OsStr::new("zsh")) {
        environment.insert("ZDOTDIR".into(), startup.as_os_str().to_owned());
    }
}

impl Resources {
    fn new(runtime: &super::support::Root) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("command-")
            .tempdir_in(runtime.path())
            .map_err(|e| format!("沙箱私有目录创建失败：{e}"))?;
        let resources = Self { directory };
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

/// 使用宿主审定的环境快照；HOME 与临时目录由本次命令独立持有。
fn environment(
    shell: &Path,
    home: &Path,
    temp: &Path,
    bin: &Path,
    configured: &super::environment::Environment,
) -> Result<BTreeMap<OsString, OsString>, String> {
    let mut environment = BTreeMap::from([
        ("PATH".into(), search_path(bin, &configured.path)?),
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
    environment.extend(configured.variables.clone());
    Ok(environment)
}

fn search_path(bin: &Path, inherited: &std::ffi::OsStr) -> Result<OsString, String> {
    std::env::join_paths(std::iter::once(bin.to_owned()).chain(std::env::split_paths(inherited)))
        .map_err(|e| format!("内置工具目录不能加入 PATH：{e}"))
}
