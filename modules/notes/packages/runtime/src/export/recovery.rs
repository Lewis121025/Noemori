//! 提交凭据独立于临时目录寿命，收到界面确认前保留；重启按文件身份与哈希核实。
use crate::{Error, Result};
use noemori_vault::export::export_file_hash;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

/// 文件身份用于区分同内容替换，路径或内容相同不能证明任务归属。
#[derive(PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PathIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}
impl PathIdentity {
    pub(super) fn of(metadata: &fs::Metadata) -> Self {
        Self {
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }
}

/// 先持久化提交意图，再原子发布；完整字段支持进程中断后的独立核验。
#[derive(PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Receipt {
    pub version: u8,
    pub id: String,
    pub target: PathBuf,
    pub temporary: PathBuf,
    pub temporary_identity: PathIdentity,
    pub hash: Option<String>,
    pub bytes: Option<u64>,
}

/// 启动时显示的核验事实；目标被删除或修改时不能声称此次没有提交。
#[derive(Serialize)]
pub(super) struct RecoveredExport {
    id: String,
    path: PathBuf,
    status: &'static str,
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-')
}

pub(super) fn lock_jobs(user_data: &Path) -> Result<(PathBuf, fs::File)> {
    let directory = user_data.join("export-jobs");
    fs::create_dir_all(&directory)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("operation.lock"))?;
    lock.try_lock()
        .map_err(|error| Error::State(format!("另一项导出尚未结束：{error}")))?;
    Ok((directory, lock))
}

pub(super) fn pending(directory: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(Error::State("导出任务编号无效".into()));
    }
    Ok(directory.join(format!("pending-{id}.json")))
}

pub(super) fn save(path: &Path, receipt: &Receipt) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::State("导出事务目录无效".into()))?;
    let mut record = tempfile::NamedTempFile::new_in(parent)?;
    record.write_all(
        &serde_json::to_vec(receipt).map_err(|error| Error::State(error.to_string()))?,
    )?;
    record.as_file().sync_all()?;
    record
        .persist(path)
        .map_err(|error| Error::Io(error.error))?;
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub(super) fn remember(directory: &Path, receipt: &Receipt) -> Result<()> {
    let path = pending(directory, &receipt.id)?;
    if path.try_exists()? {
        if read(&path)? != *receipt {
            return Err(Error::State("未确认的导出任务编号发生冲突".into()));
        }
        return Ok(());
    }
    save(&path, receipt)
}

fn read(path: &Path) -> Result<Receipt> {
    let receipt: Receipt = serde_json::from_slice(&fs::read(path)?)
        .map_err(|error| Error::State(format!("导出恢复记录无效：{error}")))?;
    if receipt.version != 1
        || !valid_id(&receipt.id)
        || !receipt.target.is_absolute()
        || !receipt.temporary.is_absolute()
        || receipt.target.parent() != receipt.temporary.parent()
        || !receipt
            .temporary
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".noemori-export-"))
        || receipt.hash.is_some() != receipt.bytes.is_some()
        || receipt.hash.as_ref().is_some_and(|hash| {
            hash.len() != 64 || !hash.bytes().all(|value| value.is_ascii_hexdigit())
        })
    {
        return Err(Error::State("导出恢复记录契约无效".into()));
    }
    Ok(receipt)
}

fn matches_identity(path: &Path, expected: &PathIdentity) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()
            && !metadata.file_type().is_symlink()
            && PathIdentity::of(&metadata) == *expected),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn recover(directory: &Path) -> Result<Vec<RecoveredExport>> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with("job-") || !entry.file_type()?.is_dir()
        {
            continue;
        }
        let path = entry.path().join("receipt.json");
        if path.try_exists()? {
            remember(directory, &read(&path)?)?;
        }
        // 只有本运行时的任务目录参与清理，目标文件始终不参与。
        fs::remove_dir_all(entry.path())?;
    }
    let mut results = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with("pending-")
            || !entry.file_type()?.is_file()
        {
            continue;
        }
        let receipt = read(&entry.path())?;
        if entry.path() != pending(directory, &receipt.id)? {
            return Err(Error::State("导出恢复任务身份不一致".into()));
        }
        if matches_identity(&receipt.temporary, &receipt.temporary_identity)? {
            fs::remove_file(&receipt.temporary)?;
        }
        let saved = if let (Some(hash), Some(bytes)) = (&receipt.hash, receipt.bytes) {
            matches_identity(&receipt.target, &receipt.temporary_identity)?
                && export_file_hash(&receipt.target, &mut |_| Ok(()))? == (hash.clone(), bytes)
        } else {
            false
        };
        results.push(RecoveredExport {
            id: receipt.id,
            path: receipt.target,
            status: if saved { "saved" } else { "unconfirmed" },
        });
    }
    results.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(results)
}

pub(super) fn acknowledge(directory: &Path, id: &str) -> Result<()> {
    let path = pending(directory, id)?;
    match fs::remove_file(path) {
        Ok(()) => fs::File::open(directory)?.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
