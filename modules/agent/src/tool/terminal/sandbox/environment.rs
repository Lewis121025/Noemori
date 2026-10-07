use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
};

/// 宿主提供的工具链环境；环境值不授予文件权限，所引用的目录仍须单独授权。
#[derive(Clone, Debug, Default)]
pub struct SandboxEnvironment {
    /// 额外的可执行目录，优先于宿主 PATH；必须是已获读取授权的绝对目录。
    pub executable_paths: Vec<PathBuf>,
    /// 明确注入的变量；禁止覆盖 PATH、HOME、TMPDIR 和 SHELL 等运行边界。
    pub variables: BTreeMap<String, String>,
}

/// 在工具创建时冻结环境，进程归属校验同时比较授权路径与变量，避免跨凭据复用。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Environment {
    pub(super) path: OsString,
    pub(super) variables: BTreeMap<OsString, OsString>,
}

impl Environment {
    pub(super) fn new(
        config: SandboxEnvironment,
        readable: &[PathBuf],
        writable: &[PathBuf],
    ) -> Result<Self, String> {
        let allowed = |path: &Path| {
            readable
                .iter()
                .chain(writable)
                .any(|root| path.starts_with(root))
        };
        let mut paths = Vec::new();
        for directory in config.executable_paths {
            let canonical = super::canonical(&directory)?;
            if !canonical.is_dir() || !allowed(&canonical) {
                return Err(format!(
                    "工具链可执行目录未获得读取授权：{}",
                    directory.display()
                ));
            }
            if !paths.contains(&canonical) {
                paths.push(canonical);
            }
        }
        // PATH 只负责发现已授权的工具，不通过宿主的私人目录隐式扩大沙箱权限。
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        for directory in std::env::split_paths(&inherited)
            .chain(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from))
        {
            if !directory.is_absolute() {
                continue;
            }
            let Ok(canonical) = directory.canonicalize() else {
                continue;
            };
            if canonical.is_dir() && allowed(&canonical) && !paths.contains(&canonical) {
                paths.push(canonical);
            }
        }
        let path = std::env::join_paths(paths).map_err(|e| format!("工具链 PATH 无效：{e}"))?;
        let mut variables = BTreeMap::new();
        for key in ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM"] {
            if let Some(value) = std::env::var_os(key) {
                variables.insert(key.into(), value);
            }
        }
        for (key, value) in config.variables {
            if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                return Err("工具链环境变量名称或值无效".into());
            }
            if matches!(key.as_str(), "PATH" | "HOME" | "TMPDIR" | "SHELL" | "PWD") {
                return Err(format!("工具链环境不能覆盖运行边界：{key}"));
            }
            variables.insert(key.into(), value.into());
        }
        Ok(Self { path, variables })
    }
}
