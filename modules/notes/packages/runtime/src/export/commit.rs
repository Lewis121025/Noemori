//! 最终输出在目标目录中暂存；只有完整校验后的单个文件能够进入提交边界。
use super::{
    check,
    recovery::{self, PathIdentity, Receipt},
    ExportJob,
};
use crate::{Error, OperationControl, Result};
use noemori_vault::export::export_file_hash;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

/// 同字节替换也属于目标变化；覆盖授权绑定文件身份和版本。
#[derive(PartialEq, Eq)]
struct FileVersion {
    hash: String,
    bytes: u64,
    modified: std::time::SystemTime,
    identity: PathIdentity,
}

pub(super) struct Target {
    path: PathBuf,
    expected: Option<FileVersion>,
    parent_identity: PathIdentity,
}

impl Target {
    /// 覆盖确认必须在捕获此身份之后展示，随后提交仍需复核版本。
    pub fn exists(&self) -> bool {
        self.expected.is_some()
    }

    pub fn capture(path: &Path, root: &Path, control: &OperationControl) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::State("导出目标必须是绝对路径".into()));
        }
        let parent = path
            .parent()
            .ok_or_else(|| Error::State("导出目标缺少目录".into()))?
            .canonicalize()?;
        let parent_identity = PathIdentity::of(&fs::metadata(&parent)?);
        if parent.starts_with(root.canonicalize()?) {
            return Err(Error::State("请选择笔记库之外的导出位置".into()));
        }
        let name = path
            .file_name()
            .ok_or_else(|| Error::State("导出目标缺少文件名".into()))?;
        let path = parent.join(name);
        let expected = match fs::symlink_metadata(&path) {
            Ok(meta) => {
                if !meta.is_file() || meta.file_type().is_symlink() {
                    return Err(Error::State("导出目标不是普通文件".into()));
                }
                let identity = PathIdentity::of(&meta);
                let modified = meta.modified()?;
                let (hash, bytes) = export_file_hash(&path, &mut |_| check(control))?;
                let after = fs::symlink_metadata(&path)?;
                if identity != PathIdentity::of(&after)
                    || modified != after.modified()?
                    || bytes != after.len()
                    || !after.is_file()
                {
                    return Err(Error::State("读取期间导出目标发生变化".into()));
                }
                Some(FileVersion {
                    hash,
                    bytes,
                    modified,
                    identity,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            path,
            expected,
            parent_identity,
        })
    }
}

pub(super) fn publish(job: &mut ExportJob, single: Option<&str>) -> Result<Value> {
    if !job.sealed {
        return Err(Error::State("源快照尚未封存，不能提交".into()));
    }
    let target = job
        .target
        .as_ref()
        .ok_or_else(|| Error::State("尚未选择导出位置".into()))?;
    let parent = target
        .path
        .parent()
        .ok_or_else(|| Error::State("导出目标目录无效".into()))?
        .to_path_buf();
    let mut staged = tempfile::Builder::new()
        .prefix(".noemori-export-")
        .tempfile_in(&parent)?;
    let receipt_path = job.directory.path().join("receipt.json");
    let mut receipt = Receipt {
        version: 1,
        id: job.id.clone(),
        target: target.path.clone(),
        temporary: staged.path().to_path_buf(),
        temporary_identity: PathIdentity::of(&staged.as_file().metadata()?),
        hash: None,
        bytes: None,
    };
    recovery::save(&receipt_path, &receipt)?;
    job.control.update("validating", 0, Some(job.outputs.len()));
    for (index, (path, expected)) in job.outputs.iter().enumerate() {
        let actual =
            export_file_hash(&job.directory.path().join("output").join(path), &mut |_| {
                check(&job.control)
            })?;
        if &actual != expected {
            return Err(Error::State(format!("产物校验失败：{path}")));
        }
        job.control
            .update("validating", index + 1, Some(job.outputs.len()));
    }
    job.control.update("packaging", 0, Some(job.outputs.len()));
    match single {
        Some(path) => {
            if job.outputs.len() != 1 || !job.outputs.contains_key(path) {
                return Err(Error::State("单文件输出不能丢弃伴随资源".into()));
            }
            copy(
                &job.directory.path().join("output").join(path),
                staged.as_file_mut(),
                &job.control,
            )?;
        }
        None => archive(job, staged.as_file_mut())?,
    }
    staged.as_file_mut().flush()?;
    staged.as_file().sync_all()?;
    let digest = export_file_hash(staged.path(), &mut |_| check(&job.control))?;
    // 写入提交意图后再进入不可取消边界；重启只根据目标哈希判断是否实际提交。
    receipt.hash = Some(digest.0);
    receipt.bytes = Some(digest.1);
    recovery::save(&receipt_path, &receipt)?;
    let current = Target::capture(&target.path, job.source.root(), &job.control)?;
    if current.expected != target.expected
        || current.parent_identity != target.parent_identity
        || current.path != target.path
    {
        return Err(Error::State(
            "目标文件或目录已被其他操作修改，请重新选择保存位置".into(),
        ));
    }
    if !job.control.commit() {
        return Err(Error::State("导出已取消".into()));
    }
    job.committing = true;
    // 从不可取消边界起，进程正常退出也必须留下提交意图；独立凭据持久化后才恢复自动清理。
    job.directory.disable_cleanup(true);
    let persisted = if target.expected.is_none() {
        staged.persist_noclobber(&target.path)
    } else {
        staged.persist(&target.path)
    };
    persisted.map_err(|error| Error::Io(error.error))?;
    Ok(record_committed(job, &receipt, &parent))
}

/// 发布之后的 IO 只影响警告与恢复凭据，不得再把已经生成的文件报告为未生成。
fn record_committed(job: &mut ExportJob, receipt: &Receipt, parent: &Path) -> Value {
    let mut warning = fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .err()
        .map(|e| format!("文件已生成，但目录同步失败：{e}"));
    let recorded = job
        .directory
        .path()
        .parent()
        .ok_or_else(|| Error::State("导出任务目录无效".into()))
        .and_then(|jobs| recovery::remember(jobs, receipt));
    match recorded {
        Ok(()) => {
            job.recorded = true;
            job.directory.disable_cleanup(false);
        }
        Err(error) => {
            warning = Some(format!(
                "{}结果已生成，提交凭据需要恢复：{error}",
                warning.map_or_else(String::new, |value| format!("{value}；"))
            ));
        }
    }
    let result = json!({"path":receipt.target,"warning":warning});
    job.committed = Some(result.clone());
    result
}

fn copy(path: &Path, output: &mut dyn Write, control: &OperationControl) -> Result<()> {
    let mut source = fs::File::open(path)?;
    let mut buffer = vec![0; 64 * 1024];
    loop {
        check(control)?;
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
    }
    Ok(())
}

fn archive(job: &ExportJob, output: &mut fs::File) -> Result<()> {
    let mut writer = ZipWriter::new(output);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let root = job.directory.path().join("output");
    let mut directories = job.directories.clone();
    for path in job.outputs.keys().chain(job.directories.iter()) {
        let mut parent = Path::new(path).parent();
        while let Some(path) = parent {
            if path.as_os_str().is_empty() {
                break;
            }
            directories.insert(noemori_vault::path_to_slashes(path)?);
            parent = path.parent();
        }
    }
    for directory in directories {
        writer
            .add_directory(format!("{directory}/"), options)
            .map_err(|e| Error::State(e.to_string()))?;
    }
    for (index, (path, (_, bytes))) in job.outputs.iter().enumerate() {
        writer
            .start_file(path, options.large_file(*bytes > u64::from(u32::MAX)))
            .map_err(|e| Error::State(e.to_string()))?;
        copy(&root.join(path), &mut writer, &job.control)?;
        job.control
            .update("packaging", index + 1, Some(job.outputs.len()));
    }
    let file = writer.finish().map_err(|e| Error::State(e.to_string()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| Error::State(e.to_string()))?;
    for index in 0..archive.len() {
        check(&job.control)?;
        let mut entry = archive
            .by_index(index)
            .map_err(|e| Error::State(e.to_string()))?;
        let mut buffer = vec![0; 64 * 1024];
        while entry.read(&mut buffer)? != 0 {
            check(&job.control)?;
        }
    }
    Ok(())
}
