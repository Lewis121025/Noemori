//! 将用户提供的相对路径约束在库根内。

use std::path::{Component, Path, PathBuf};

use crate::error::Error;

/// 将系统路径无损表示为协议路径，只转换当前系统的目录分隔符。
///
/// Unix 文件名中的反斜杠必须保留，不能与真实子目录混同；本函数不代替库根校验。
/// # Errors
/// 路径不是有效 UTF-8 时失败，禁止用替代字符指向另一份文件。
pub fn path_to_slashes(path: &Path) -> Result<String, Error> {
    let text = path.to_str().ok_or_else(|| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("文件名不是有效 UTF-8，无法安全识别：{}", path.display()),
        ))
    })?;
    Ok(text.replace(std::path::MAIN_SEPARATOR, "/"))
}

/// 校验并规范化相对路径，不访问磁盘；原路径失效时仍可安全保存、读取恢复记录。
pub(super) fn validate_relative_path(rel: &str) -> Result<PathBuf, Error> {
    let mut normalized = PathBuf::new();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(Error::PathEscape);
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(Error::PathEscape);
    }
    Ok(normalized)
}

/// 把库内相对路径解析为绝对路径。
///
/// 拒绝绝对路径、空路径、`..` 分量和库内符号链接，避免恢复日志写到库外。
/// 逐级检查已有父目录；这仍不能阻止外部进程在检查后替换目录。
///
/// # Errors
///
/// 越界或非法分量时返回 [`Error::PathEscape`]。
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, Error> {
    let rel_path = validate_relative_path(rel)?;
    let mut out = root.to_path_buf();
    let mut components = rel_path.components().peekable();
    while let Some(component) = components.next() {
        out.push(component.as_os_str());
        match std::fs::symlink_metadata(&out) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(Error::PathEscape),
            Ok(meta) if components.peek().is_some() && !meta.is_dir() => {
                return Err(Error::Io(std::io::Error::new(
                    std::io::ErrorKind::NotADirectory,
                    format!("父路径不是目录：{}", out.display()),
                )));
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    if out == root || !out.starts_with(root) {
        return Err(Error::PathEscape);
    }
    Ok(out)
}
