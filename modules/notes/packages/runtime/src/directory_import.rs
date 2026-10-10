//! 外部目录先完整暂存并复核，再以不覆盖的目录提交发布；取消不留下半份副本。
use crate::{Error, OperationControl, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(PartialEq, Eq)]
struct Entry {
    path: PathBuf,
    directory: bool,
    bytes: u64,
    modified: SystemTime,
}

/// 暂存阶段拥有唯一临时目录，只有完整目录可以被提交；未提交时自动清理。
pub(crate) struct PreparedImport {
    pub path: String,
    pub target: PathBuf,
    pub files: usize,
    staged: tempfile::TempDir,
}

/// 已完成副本的结果；目录同步故障只附加警告，不能重试成第二份副本。
#[derive(Serialize, Deserialize)]
pub(crate) struct ImportedDirectory {
    pub path: String,
    pub files: usize,
    pub warning: Option<String>,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::State(message.into())
}

fn inventory(source: &Path, control: &OperationControl) -> Result<Option<Vec<Entry>>> {
    let mut pending = vec![PathBuf::new()];
    let mut entries = Vec::new();
    while let Some(directory) = pending.pop() {
        if control.cancelled() {
            return Ok(None);
        }
        for item in fs::read_dir(source.join(&directory))? {
            if control.cancelled() {
                return Ok(None);
            }
            let item = item?;
            let path = directory.join(item.file_name());
            noemori_vault::path_to_slashes(&path)?;
            let metadata = fs::symlink_metadata(item.path())?;
            if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
                return Err(invalid(format!(
                    "目录包含符号链接或特殊文件，未导入：{}",
                    item.path().display()
                )));
            }
            if metadata.is_dir() {
                pending.push(path.clone());
            }
            entries.push(Entry {
                path,
                directory: metadata.is_dir(),
                bytes: metadata.len(),
                modified: metadata.modified()?,
            });
            control.update("scanning", entries.len(), None);
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Some(entries))
}

/// 准备完整副本；源目录和仓库不能互为祖先，父目录必须已存在。
/// 原文件保持原位，所有隐藏文件和空目录一起复制，相对链接不改写。
pub(crate) fn prepare(
    root: &Path,
    source: &Path,
    parent: &str,
    control: &OperationControl,
) -> Result<Option<PreparedImport>> {
    if control.cancelled() {
        return Ok(None);
    }
    let root = root.canonicalize()?;
    let source = source.canonicalize()?;
    if !source.is_dir() || root.starts_with(&source) || source.starts_with(&root) {
        return Err(invalid("请选择仓库之外且不包含仓库的文件夹"));
    }
    if !parent.is_empty() && !crate::session::entry_path(parent) {
        return Err(invalid("导入目标目录无效"));
    }
    let parent_path = if parent.is_empty() {
        root.clone()
    } else {
        root.join(parent)
    };
    let actual_parent = parent_path.canonicalize()?;
    if actual_parent != parent_path || !actual_parent.starts_with(&root) || !actual_parent.is_dir()
    {
        return Err(invalid("导入目标必须是仓库内的真实文件夹"));
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid("源目录名称无效"))?;
    if name.starts_with('.') || !crate::session::entry_path(name) {
        return Err(invalid("此目录名称不能作为仓库内的文件夹名称"));
    }
    let Some(entries) = inventory(&source, control)? else {
        return Ok(None);
    };
    let mut suffix = 1usize;
    let (path, target) = loop {
        let name = if suffix == 1 {
            name.to_owned()
        } else {
            format!("{name} ({suffix})")
        };
        let target = actual_parent.join(&name);
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let path = if parent.is_empty() {
                    name
                } else {
                    format!("{parent}/{name}")
                };
                break (path, target);
            }
            Err(error) => return Err(error.into()),
            Ok(_) => suffix += 1,
        }
    };
    let staged = tempfile::Builder::new()
        .prefix(".noemori-import-")
        .tempdir_in(&actual_parent)?;
    let Some(files) = copy_entries(&source, staged.path(), &entries, control)? else {
        return Ok(None);
    };
    control.update("verifying", 0, Some(entries.len()));
    let Some(after) = inventory(&source, control)? else {
        return Ok(None);
    };
    if entries != after {
        return Err(invalid("复制期间源目录发生变化，请重新导入"));
    }
    control.update("verifying", entries.len(), Some(entries.len()));
    write_source_manifest(staged.path(), &source)?;
    Ok(Some(PreparedImport {
        path,
        target,
        files,
        staged,
    }))
}

// 暂存副本持有全部写入；取消只返回未完成状态，由调用方的 TempDir 回收。
fn copy_entries(
    source: &Path,
    staged: &Path,
    entries: &[Entry],
    control: &OperationControl,
) -> Result<Option<usize>> {
    let mut files = 0;
    let mut buffer = vec![0u8; 128 * 1024];
    for (index, entry) in entries.iter().enumerate() {
        if control.cancelled() {
            return Ok(None);
        }
        control.update("copying", index, Some(entries.len()));
        let destination = staged.join(&entry.path);
        if entry.directory {
            fs::create_dir(&destination)?;
        } else {
            let source_path = source.join(&entry.path);
            if fs::symlink_metadata(&source_path)?.file_type().is_symlink() {
                return Err(invalid("复制期间源文件变成了符号链接，请重试"));
            }
            let mut input = fs::File::open(&source_path)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)?;
            loop {
                if control.cancelled() {
                    return Ok(None);
                }
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                output.write_all(&buffer[..count])?;
            }
            output.sync_all()?;
            output.set_times(fs::FileTimes::new().set_modified(entry.modified))?;
            fs::set_permissions(&destination, input.metadata()?.permissions())?;
            files += 1;
        }
    }
    for entry in entries.iter().rev().filter(|entry| entry.directory) {
        fs::set_permissions(
            staged.join(&entry.path),
            fs::metadata(source.join(&entry.path))?.permissions(),
        )?;
    }
    Ok(Some(files))
}

// 来源元数据只能写入已复核的暂存目录；冲突文件不能被当作旧导入记录覆盖。
fn write_source_manifest(staged: &Path, source: &Path) -> Result<()> {
    let manifest = staged.join(".noemori-library-source.json");
    if manifest.try_exists()? {
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest)?).map_err(std::io::Error::other)?;
        if value["version"] != 1 || !value["source"].is_string() {
            return Err(invalid("导入元数据名称被其他文件占用，未覆盖任何文件"));
        }
    }
    fs::write(
        &manifest,
        serde_json::to_vec(
            &serde_json::json!({"version": 1, "source": noemori_vault::path_to_slashes(source)?}),
        )
        .map_err(std::io::Error::other)?,
    )?;
    fs::File::open(&manifest)?.sync_all()?;
    fs::File::open(staged)?.sync_all()?;
    Ok(())
}

impl PreparedImport {
    pub fn mark(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.staged.path().join(name))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }

    /// 从单一提交边界发布目录；目标在准备期间被占用时拒绝，绝不合并或覆盖。
    pub fn commit(self, control: &OperationControl) -> Result<Option<ImportedDirectory>> {
        if !control.commit() {
            return Ok(None);
        }
        #[cfg(unix)]
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            self.staged.path(),
            rustix::fs::CWD,
            &self.target,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(std::io::Error::from)?;
        #[cfg(not(unix))]
        fs::rename(self.staged.path(), &self.target)?;
        let warning = self
            .target
            .parent()
            .and_then(|parent| {
                fs::File::open(parent)
                    .and_then(|file| file.sync_all())
                    .err()
            })
            .map(|error| format!("副本已导入，目录同步失败：{error}"));
        Ok(Some(ImportedDirectory {
            path: self.path,
            files: self.files,
            warning,
        }))
    }
}
