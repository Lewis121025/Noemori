//! 文件能力锚定授权目录 fd；页面只获得固定字节，不能自行读取本地路径。
use base64::{Engine, engine::general_purpose::STANDARD};
#[cfg(unix)]
use rustix::fs::{self as fs, AtFlags, Mode, OFlags};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
pub(crate) const FILE_LIMIT: usize = 32 * 1024 * 1024;

/// 宿主固定的上传字节；文件名不包含真实目录，MIME 从最终文件名解析。
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct UploadFile {
    pub name: String,
    pub mime_type: String,
    pub data: String,
}

/// 根目录 fd 跨读取保持身份，防止路径核验后父目录被 symlink 替换。
pub(crate) struct UiFiles {
    root: PathBuf,
    #[cfg(unix)]
    directory: File,
    protected: PathBuf,
}
impl UiFiles {
    pub(crate) fn new(root: PathBuf, protected: PathBuf) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let protected = match protected.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => protected
                .parent()
                .ok_or("UI 私有目录缺少父路径")?
                .canonicalize()
                .map_err(|e| e.to_string())?
                .join(protected.file_name().ok_or("UI 私有目录缺少名称")?),
            Err(error) => return Err(error.to_string()),
        };
        #[cfg(unix)]
        let directory = File::from(
            fs::open(
                &root,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|e| e.to_string())?,
        );
        Ok(Self {
            root,
            #[cfg(unix)]
            directory,
            protected,
        })
    }
    fn relative(&self, path: &Path) -> Result<PathBuf, String> {
        if path.starts_with(&self.protected) {
            return Err("UI 私有连接与授权材料不可交给网页".into());
        }
        path.strip_prefix(&self.root)
            .map(Path::to_path_buf)
            .map_err(|_| "文件不属于已授权工作区".into())
    }
    #[cfg(unix)]
    fn parent(&self, relative: &Path) -> Result<(File, std::ffi::OsString), String> {
        let mut components = relative.components().collect::<Vec<_>>();
        let name = match components.pop() {
            Some(Component::Normal(name)) => name.to_owned(),
            _ => return Err("文件名称无效".into()),
        };
        let mut directory = self.directory.try_clone().map_err(|e| e.to_string())?;
        for component in components {
            let Component::Normal(name) = component else {
                return Err("文件路径不能逃逸根目录".into());
            };
            directory = File::from(
                fs::openat(
                    &directory,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                    Mode::empty(),
                )
                .map_err(|e| e.to_string())?,
            );
        }
        Ok((directory, name))
    }
    pub(crate) fn upload(&self, paths: &[String]) -> Result<Vec<UploadFile>, String> {
        #[cfg(not(unix))]
        {
            let _ = paths;
            Err("文件能力暂不支持此平台".into())
        }
        #[cfg(unix)]
        {
            if paths.len() > 50 {
                return Err("上传文件数量超限".into());
            }
            let mut total = 0;
            let mut result = Vec::new();
            for path in paths {
                let path = self
                    .root
                    .join(path)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                let relative = self.relative(&path)?;
                let (directory, name) = self.parent(&relative)?;
                let file = File::from(
                    fs::openat(
                        &directory,
                        &name,
                        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
                        Mode::empty(),
                    )
                    .map_err(|e| e.to_string())?,
                );
                let before = file.metadata().map_err(|e| e.to_string())?;
                if !before.is_file() || before.len() > (FILE_LIMIT - total) as u64 {
                    return Err("上传必须是预算内的普通文件".into());
                }
                let mut bytes = Vec::new();
                (&file)
                    .take((FILE_LIMIT - total + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                let after = file.metadata().map_err(|e| e.to_string())?;
                use std::os::unix::fs::MetadataExt;
                if bytes.len() != before.len() as usize
                    || after.len() != before.len()
                    || after.modified().map_err(|e| e.to_string())?
                        != before.modified().map_err(|e| e.to_string())?
                    || before.ctime() != after.ctime()
                    || before.ctime_nsec() != after.ctime_nsec()
                {
                    return Err("上传文件在读取期间发生变化".into());
                }
                total += bytes.len();
                let name = name.to_str().ok_or("上传名称必须是 Unicode")?.to_owned();
                result.push(UploadFile {
                    name: name.clone(),
                    mime_type: mime_guess::from_path(&name)
                        .first_or_octet_stream()
                        .to_string(),
                    data: STANDARD.encode(bytes),
                });
            }
            Ok(result)
        }
    }
    pub(crate) fn save(&self, source: &Path, destination: &str) -> Result<String, String> {
        #[cfg(not(unix))]
        {
            let _ = (source, destination);
            Err("文件能力暂不支持此平台".into())
        }
        #[cfg(unix)]
        {
            let requested = self.root.join(destination);
            let name = requested.file_name().ok_or("保存名称无效")?;
            let parent = requested
                .parent()
                .ok_or("保存目录无效")?
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let output = parent.join(name);
            let relative = self.relative(&output)?;
            let (directory, name) = self.parent(&relative)?;
            let temporary = format!(".nui-{}", uuid::Uuid::new_v4());
            let mut target = File::from(
                fs::openat(
                    &directory,
                    &temporary,
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::CLOEXEC
                        | OFlags::NOFOLLOW,
                    Mode::from_raw_mode(0o600),
                )
                .map_err(|e| e.to_string())?,
            );
            let result = (|| {
                let mut input = File::open(source).map_err(|e| e.to_string())?;
                if input.metadata().map_err(|e| e.to_string())?.len() > FILE_LIMIT as u64 {
                    return Err("下载文件超过预算".into());
                }
                let copied = std::io::copy(
                    &mut Read::by_ref(&mut input).take(FILE_LIMIT as u64 + 1),
                    &mut target,
                )
                .map_err(|e| e.to_string())?;
                if copied > FILE_LIMIT as u64 {
                    return Err("下载文件在保存期间超过预算".into());
                }
                target.flush().map_err(|e| e.to_string())?;
                // 先写完整私有文件再创建最终名称；硬链接原子拒绝覆盖，父目录始终由 fd 锚定。
                fs::linkat(&directory, &temporary, &directory, &name, AtFlags::empty())
                    .map_err(|e| format!("保存失败，目标可能已存在或目录不支持原子保存：{e}"))?;
                Ok(output.to_string_lossy().into_owned())
            })();
            let cleanup =
                fs::unlinkat(&directory, &temporary, AtFlags::empty()).map_err(|e| e.to_string());
            match (result, cleanup) {
                (Ok(value), Ok(())) => Ok(value),
                (Err(error), Ok(())) => Err(error),
                (result, Err(cleanup)) => Err(format!(
                    "{}；清理暂存失败：{cleanup}",
                    result.err().unwrap_or_default()
                )),
            }
        }
    }
}
