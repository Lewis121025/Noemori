//! 保存的提交边界：先保留草稿，再核对磁盘，最后原子替换。

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use tempfile::{Builder, NamedTempFile};

use crate::storage::path::{path_to_slashes, resolve_in_root, validate_relative_path};
use crate::{Draft, EntryKind, Error, Vault};

/// 文件已提交与版本冲突是不同结果；索引失败不撤销已经提交的内容。
#[derive(Debug)]
pub enum WriteOutcome {
    /// 内容已写入；警告表示目录同步、索引更新或草稿清理需要重试。
    Saved { warning: Option<String> },
    /// 磁盘与编辑基准不同；`None` 表示文件已被删除。
    Conflict { disk: Option<Vec<u8>> },
}

/// 打开编辑器所需的磁盘内容和未提交草稿。
#[derive(Debug)]
pub struct FileSnapshot {
    /// 当前磁盘字节；删除后的草稿也可以打开。
    pub disk: Option<Vec<u8>>,
    /// 原路径无法读取时仍返回恢复草稿，并单独携带磁盘错误，不把它误报为删除。
    pub disk_error: Option<String>,
    /// 上次保存失败或冲突时保留的内容。
    pub draft: Option<Draft>,
}

/// 另存副本的最终路径与提交后的警告。
#[derive(Debug)]
pub struct SavedCopy {
    /// 新文件的库内相对路径。
    pub path: String,
    /// 内容已写入，但派生状态或持久化确认失败。
    pub warning: Option<String>,
}

impl Vault {
    /// 读取磁盘与恢复草稿，已落盘的同内容草稿不再重复恢复。
    ///
    /// `rel` 为库内相对路径。返回可用于重建编辑器的快照。
    ///
    /// # Errors
    ///
    /// 越界、读盘或读取恢复记录失败。
    pub fn snapshot(&self, rel: &str) -> Result<FileSnapshot, Error> {
        let _guard = self.lock_writes()?;
        validate_relative_path(rel)?;
        let draft = self.recovery.get(rel)?;
        let (disk, disk_error) =
            match resolve_in_root(self.root(), rel).and_then(|path| read_optional(&path)) {
                Ok(disk) => (disk, None),
                Err(error) if draft.is_some() => (None, Some(error.to_string())),
                Err(error) => return Err(error),
            };
        let draft = draft.filter(|draft| !draft.is_committed(disk.as_deref()));
        Ok(FileSnapshot {
            disk,
            disk_error,
            draft,
        })
    }

    /// 仅持久化无法映射为 Markdown 的编辑器快照，不改写笔记或触发索引。
    ///
    /// `source` 是会话原始 UTF-8 源码，`expected` 是磁盘基准，`editor` 是编辑器版本化恢复数据。
    /// 记录可在原文件被删除、父目录不可用或改名恢复尚未完成时保留。
    ///
    /// # Errors
    /// 路径非法、非 Markdown、无效 UTF-8、空恢复数据、草稿路径冲突或恢复数据库不可写。
    pub fn preserve_editor_draft(
        &self,
        rel: &str,
        source: &[u8],
        expected: Option<&[u8]>,
        editor: &str,
    ) -> Result<(), Error> {
        let _guard = self.lock_writes()?;
        validate_relative_path(rel)?;
        if !rel.to_lowercase().ends_with(".md")
            || std::str::from_utf8(source).is_err()
            || editor.is_empty()
        {
            return Err(Error::Io(io::Error::other(
                "编辑器恢复记录需要 Markdown 路径、UTF-8 源码及非空内容",
            )));
        }
        self.recovery
            .put_editor(rel, source, expected, Some(editor))
    }

    /// 基于 `expected` 保存 `bytes`；缺失基准表示仅允许创建新文件。
    ///
    /// 保存尝试先落入恢复记录。已知的外部修改返回冲突，不修改目标；
    /// 应用内写入串行，但无法阻止其他进程在核对与替换之间写入。
    ///
    /// # Errors
    ///
    /// 越界、与其他草稿路径冲突、草稿持久化或提交前的 IO 失败。
    /// 提交后的问题随成功结果返回。
    pub fn write(
        &self,
        rel: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<WriteOutcome, Error> {
        let _guard = self.lock_writes()?;
        validate_relative_path(rel)?;
        self.recovery.put(rel, bytes, expected)?;
        crate::rename::recover_pending(self.root(), &self.recovery)?;
        let path = resolve_in_root(self.root(), rel)?;
        let disk = read_optional(&path)?;
        if disk.as_deref() != expected {
            return Ok(WriteOutcome::Conflict { disk });
        }
        let staged = stage(&path, bytes)?;
        // 草稿与临时文件的同步可能较慢，提交前再次检查外部修改。
        let disk = read_optional(&path)?;
        if disk.as_deref() != expected {
            return Ok(WriteOutcome::Conflict { disk });
        }
        if expected.is_none() {
            match staged.persist_noclobber(&path) {
                Ok(_) => {}
                Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => {
                    return Ok(WriteOutcome::Conflict {
                        disk: read_optional(&path)?,
                    });
                }
                Err(err) => return Err(err.error.into()),
            }
        } else {
            staged.persist(&path).map_err(|err| err.error)?;
        }
        Ok(WriteOutcome::Saved {
            warning: self.finish_write(rel, bytes, rel),
        })
    }

    /// 将 `bytes` 保存为新副本，保留原文件和已有副本；原父目录不可用时存入库根。
    ///
    /// `rel` 为原文件路径，`expected` 仅用于记录恢复草稿的基准。
    /// 返回实际创建的路径；跳过被恢复草稿占用的候选名，并使用独占创建保护已有文件。
    ///
    /// # Errors
    ///
    /// 路径非法、恢复记录或副本提交失败。
    pub fn write_copy(
        &self,
        rel: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<SavedCopy, Error> {
        let _guard = self.lock_writes()?;
        let relative = validate_relative_path(rel)?;
        self.recovery.put(rel, bytes, expected)?;
        crate::rename::recover_pending(self.root(), &self.recovery)?;
        let parent = relative.parent().ok_or(Error::PathEscape)?;
        let original_parent = if parent.as_os_str().is_empty() {
            Some(self.root().to_path_buf())
        } else {
            resolve_in_root(self.root(), &parent.to_string_lossy())
                .ok()
                .filter(|path| path.is_dir())
        };
        let mut moved_to_root = original_parent.is_none();
        let mut directory = original_parent.unwrap_or_else(|| self.root().to_path_buf());
        // 副本是新文件，不继承原文件的权限；只读父目录不能阻断草稿恢复。
        let mut staged = match stage_bytes(&directory, bytes, None) {
            Err(Error::Io(error))
                if directory != self.root()
                    && matches!(
                        error.kind(),
                        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
                    ) =>
            {
                directory = self.root().to_path_buf();
                moved_to_root = true;
                stage_bytes(&directory, bytes, None)?
            }
            result => result?,
        };
        let path = directory.join(relative.file_name().ok_or(Error::PathEscape)?);
        let stem = path.file_stem().ok_or(Error::PathEscape)?.to_string_lossy();
        let extension = path
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()))
            .unwrap_or_default();
        for number in 1_u64.. {
            let suffix = if number == 1 {
                "副本".to_string()
            } else {
                format!("副本 {number}")
            };
            let candidate = path.with_file_name(format!("{stem} ({suffix}){extension}"));
            let copy_rel = path_to_slashes(
                candidate
                    .strip_prefix(self.root())
                    .map_err(|_| Error::PathEscape)?,
            )?;
            if self
                .recovery
                .conflicting_path(&copy_rel, EntryKind::File, None)?
                .is_some()
            {
                continue;
            }
            match staged.persist_noclobber(&candidate) {
                Ok(_) => {
                    let mut warnings = Vec::new();
                    if moved_to_root {
                        warnings.push("原文件夹不可用，副本已保存到笔记库根目录。".to_string());
                    }
                    if let Some(warning) = self.finish_write(&copy_rel, bytes, rel) {
                        warnings.push(warning);
                    }
                    let warning = (!warnings.is_empty()).then(|| warnings.join("；"));
                    return Ok(SavedCopy {
                        path: copy_rel,
                        warning,
                    });
                }
                Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => staged = err.file,
                Err(err) => return Err(err.error.into()),
            }
        }
        Err(Error::Io(io::Error::other("副本名称已耗尽")))
    }

    fn finish_write(&self, rel: &str, bytes: &[u8], recovery_rel: &str) -> Option<String> {
        let mut warnings = Vec::new();
        let synced = sync_parent(&self.root().join(rel));
        if let Err(err) = &synced {
            warnings.push(format!("目录同步失败，恢复草稿已保留：{err}"));
        }
        if let Err(err) = self.reindex_written(rel, bytes) {
            warnings.push(format!("链接索引更新失败：{err}"));
        }
        if synced.is_ok() {
            if let Err(err) = self.recovery.remove(recovery_rel) {
                warnings.push(format!("恢复草稿清理失败：{err}"));
            }
        }
        (!warnings.is_empty()).then(|| warnings.join("；"))
    }
}

pub(crate) fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, Error> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub(crate) fn stage(path: &Path, bytes: &[u8]) -> Result<NamedTempFile, Error> {
    let parent = path.parent().ok_or(Error::PathEscape)?;
    fs::create_dir_all(parent)?;
    stage_bytes(
        parent,
        bytes,
        fs::metadata(path)
            .ok()
            .map(|metadata| metadata.permissions()),
    )
}

/// 在 `parent` 内暂存 `bytes` 并持久化最终权限；返回可用于原子替换的文件。
/// 创建、写入、设置权限或同步失败时返回 IO 错误，临时文件由所有权释放清理。
pub(crate) fn stage_bytes(
    parent: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> Result<NamedTempFile, Error> {
    let file = write_staged_bytes(parent, bytes, permissions)?;
    file.as_file().sync_all()?;
    Ok(file)
}

/// 在 `parent` 内写入 `bytes` 和最终权限，返回尚未同步的私有暂存文件。
/// 调用方必须同步成功后才能替换正式路径；创建、写入或设置权限失败返回 IO 错误。
pub(crate) fn write_staged_bytes(
    parent: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> Result<NamedTempFile, Error> {
    let mut file = Builder::new().prefix(".nous-").tempfile_in(parent)?;
    file.write_all(bytes)?;
    // 暂存文件先以私有权限写完，再恢复最终权限，避免写入清掉源文件的特殊权限位。
    if let Some(permissions) = permissions {
        file.as_file().set_permissions(permissions)?;
    }
    Ok(file)
}

pub(crate) fn sync_parent(path: &Path) -> io::Result<()> {
    sync_directory(
        path.parent()
            .ok_or_else(|| io::Error::other("路径没有父目录"))?,
    )
}

/// 同步目录项；改名事务在提交标记前按目录去重，单文件保存仍同步其父目录。
pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
