//! 分组持久化暂存内容，正式路径按日志顺序替换，目录落盘后才记录提交。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use tempfile::NamedTempFile;

use super::{check_version, moved_path, version_permissions};
use crate::storage::path::resolve_in_root;
use crate::storage::recovery::RecoveryStore;
use crate::rename::journal::{FileChange, RenameJournal};
use crate::storage::save::{sync_parent, write_staged_bytes};
use crate::Error;

// 限制同时打开的暂存文件和目录数量，避免大目录耗尽文件描述符。
const SYNC_GROUP_SIZE: usize = 4;

/// 暂存内容尚不能替换正式文件；先完成整组同步，再逐项复核版本和提交。
enum StagedVersion {
    Write(NamedTempFile),
    Remove,
}

impl StagedVersion {
    fn file(&self) -> Option<&fs::File> {
        match self {
            Self::Write(file) => Some(file.as_file()),
            Self::Remove => None,
        }
    }
}

/// 在库根 `root` 内应用 `journal`；`store` 必须已经持久化该日志。
/// 返回成功表示内容、目录和提交标记均已落盘。
/// 暂存、校验、同步或日志写入失败时返回错误，由外层恢复未提交事务。
pub(super) fn apply_rename(
    root: &Path,
    store: &RecoveryStore,
    journal: &RenameJournal,
) -> Result<(), Error> {
    let mut directories = BTreeSet::new();
    for directory in &journal.directories {
        create_move_directory(root, store, journal, directory)?;
        let path = resolve_in_root(root, directory)?;
        directories.insert(path.parent().ok_or(Error::PathEscape)?.to_path_buf());
    }
    for (group, changes) in journal.changes.chunks(SYNC_GROUP_SIZE).enumerate() {
        // 整组内容先落盘，再允许任一正式路径被替换；中断后只能观察到完整的前后版本。
        let staged: Vec<_> = changes
            .iter()
            .map(|change| {
                stage_version(
                    root,
                    change,
                    change.before.as_deref(),
                    change.after.as_deref(),
                )
            })
            .collect::<Result<_, _>>()?;
        sync_files(
            &staged
                .iter()
                .filter_map(StagedVersion::file)
                .collect::<Vec<_>>(),
        )?;
        for (offset, (change, version)) in changes.iter().zip(staged).enumerate() {
            let ordinal = group * SYNC_GROUP_SIZE + offset;
            store.start_rename_step(ordinal)?;
            let result = install_version(root, change, change.before.as_deref(), version);
            if let Err(cause) = &result {
                // 撤销失败时日志仍待恢复；必须同时保留文件失败的原因，才能判断恢复阻碍。
                store
                    .cancel_rename_step(ordinal)
                    .map_err(|error| Error::RenameRecovery {
                        detail: format!(
                            "文件 {} 提交失败：{cause}；撤销步骤标记失败：{error}。恢复记录已保留",
                            change.path
                        ),
                    })?;
            }
            let path = result?;
            directories.insert(path.parent().ok_or(Error::PathEscape)?.to_path_buf());
        }
    }
    // 每个文件和受影响目录均同步成功后，才允许日志声明该条目已经提交。
    sync_directories(&directories)?;
    store.commit_rename()
}

/// 将 `root` 内 `change.path` 的 `expected` 版本恢复为 `desired`；`None` 表示路径应不存在。
/// 返回实际替换路径；调用方须同步其父目录后才能进入下一恢复步骤。
/// 路径越界、版本冲突、暂存、同步或替换失败时返回错误，不清理恢复日志。
pub(super) fn replace_version(
    root: &Path,
    change: &FileChange,
    expected: Option<&[u8]>,
    desired: Option<&[u8]>,
) -> Result<PathBuf, Error> {
    let version = stage_version(root, change, expected, desired)?;
    if let Some(file) = version.file() {
        file.sync_all()?;
    }
    install_version(root, change, expected, version)
}

fn stage_version(
    root: &Path,
    change: &FileChange,
    expected: Option<&[u8]>,
    desired: Option<&[u8]>,
) -> Result<StagedVersion, Error> {
    let path = resolve_in_root(root, &change.path)?;
    check_version(&path, expected)?;
    let Some(bytes) = desired else {
        return Ok(StagedVersion::Remove);
    };
    let parent = path.parent().ok_or(Error::PathEscape)?;
    fs::create_dir_all(parent)?;
    let permissions = version_permissions(parent, change.permissions)?;
    Ok(StagedVersion::Write(write_staged_bytes(
        parent,
        bytes,
        Some(permissions),
    )?))
}

/// 调用方已同步暂存内容；重新校验路径与正文，成功替换后不再执行可失败操作。
fn install_version(
    root: &Path,
    change: &FileChange,
    expected: Option<&[u8]>,
    version: StagedVersion,
) -> Result<PathBuf, Error> {
    let path = resolve_in_root(root, &change.path)?;
    check_version(&path, expected)?;
    match version {
        StagedVersion::Write(file) if expected.is_none() => {
            file.persist_noclobber(&path).map_err(|error| error.error)?;
        }
        StagedVersion::Write(file) => {
            file.persist(&path).map_err(|error| error.error)?;
        }
        StagedVersion::Remove => fs::remove_file(&path)?,
    }
    Ok(path)
}

fn sync_directories(directories: &BTreeSet<PathBuf>) -> Result<(), Error> {
    #[cfg(unix)]
    for paths in directories
        .iter()
        .collect::<Vec<_>>()
        .chunks(SYNC_GROUP_SIZE)
    {
        let files = paths
            .iter()
            .map(fs::File::open)
            .collect::<Result<Vec<_>, _>>()?;
        sync_files(&files.iter().collect::<Vec<_>>())?;
    }
    #[cfg(not(unix))]
    let _ = directories;
    Ok(())
}

fn create_move_directory(
    root: &Path,
    store: &RecoveryStore,
    journal: &RenameJournal,
    directory: &str,
) -> Result<(), Error> {
    let path = resolve_in_root(root, directory)?;
    let original = moved_path(directory, &journal.to, &journal.from);
    let permissions = if original == directory {
        None
    } else {
        Some(fs::metadata(resolve_in_root(root, &original)?)?.permissions())
    };
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    if let Some(permissions) = &permissions {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        // 创建时就限制访问，不能短暂将私有目录暴露为系统默认权限。
        builder.mode(permissions.mode());
    }
    builder.create(&path)?;
    // mkdir 与 SQLite 无法原子提交；中间退出时保留未确认的空目录，不能推测归属并删除。
    if let Err(cause) = store.record_created_directory(directory) {
        fs::remove_dir(&path).map_err(|error| Error::RenameRecovery {
            detail: format!("目录归属记录失败：{cause}；清理 {directory} 失败：{error}"),
        })?;
        sync_parent(&path)?;
        return Err(cause);
    }
    if let Some(permissions) = permissions {
        fs::set_permissions(&path, permissions)?;
    }
    Ok(())
}

/// macOS 的 `F_FULLFSYNC` 会持久化同一设备上此前 `fsync` 的数据（`fcntl(2)`）。
/// 文件暂存和目录提交分别使用此屏障；任何失败都必须中止事务，不能退化为普通同步。
fn sync_files(files: &[&fs::File]) -> std::io::Result<()> {
    if files.len() <= 1 {
        for file in files {
            file.sync_all()?;
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::MetadataExt;
        // 按设备分别完成强同步，跨挂载点不能共享屏障。
        let mut devices = std::collections::BTreeMap::new();
        for file in files {
            rustix::fs::fsync(*file).map_err(std::io::Error::from)?;
            devices.entry(file.metadata()?.dev()).or_insert(*file);
        }
        for file in devices.values() {
            rustix::fs::fcntl_fullfsync(*file).map_err(std::io::Error::from)?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    for file in files {
        file.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../../../../../test/notes/vault/integration/rename/rename_commit.rs"]
mod tests;
