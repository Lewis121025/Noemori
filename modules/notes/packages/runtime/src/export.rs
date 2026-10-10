//! 导出任务的能力边界：只有宿主创建的任务能访问冻结源、暂存产物和批准的目标。
mod commit;
mod recovery;

use crate::{Error, OperationControl, Result, State};
use noemori_vault::{
    export::{export_file_hash, ExportSnapshot, EXPORT_BYTE_LIMIT, EXPORT_FILE_LIMIT},
    LinkKind, LinkTarget,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};
use tempfile::TempDir;

const DOWNLOAD_LIMIT: usize = 64 * 1024 * 1024;

/// 每个运行时最多拥有一个导出任务；封存后转换不再读取源库。
pub(crate) struct ExportJob {
    id: String,
    generation: u64,
    directory: TempDir,
    source: ExportSnapshot,
    control: OperationControl,
    outputs: BTreeMap<String, (String, u64)>,
    directories: BTreeSet<String>,
    resource_bytes: u64,
    resources: usize,
    sealed: bool,
    committing: bool,
    committed: Option<Value>,
    recorded: bool,
    target: Option<commit::Target>,
    _lock: fs::File,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Info {},
    Outcome {},
    Preserve {},
    Acknowledge {},
    Include {
        path: String,
    },
    Resolve {
        from: String,
        raw: String,
        kind: String,
    },
    Seal {},
    Copy {
        source: String,
        path: String,
    },
    Write {
        path: String,
        resource: bool,
    },
    Directory {
        path: String,
    },
    Target {
        path: String,
    },
    Publish {
        single: Option<String>,
    },
    Retain {
        paths: Vec<String>,
    },
    Discard {},
}

impl State {
    /// 建立唯一任务并读取源快照；未完成任务不能被另一次请求覆盖。
    /// # Errors
    /// 笔记库失效、草稿未处理、非法任务编号或快照失败。
    pub fn export_prepare(
        &mut self,
        root: &str,
        id: String,
        paths: Option<Vec<String>>,
        hidden: bool,
        control: OperationControl,
    ) -> Result<Value> {
        self.require_root(root)?;
        if self.export.is_some() {
            return Err(Error::State("已有导出任务正在执行".into()));
        }
        if !recovery::valid_id(&id) {
            return Err(Error::State("导出任务编号无效".into()));
        }
        let (jobs, lock) = recovery::lock_jobs(&self.user_data)?;
        recovery::recover(&jobs)?;
        if recovery::pending(&jobs, &id)?.try_exists()? {
            return Err(Error::State("导出任务编号尚未确认，不能重复使用".into()));
        }
        let directory = tempfile::Builder::new().prefix("job-").tempdir_in(&jobs)?;
        fs::create_dir(directory.path().join("output"))?;
        let vault = self.vault()?;
        let source = vault.export_snapshot(paths, hidden, directory.path(), &mut |completed| {
            if control.cancelled() {
                return Err(cancelled());
            }
            let completed = completed.max(control.progress().completed);
            control.update("snapshotting", completed, None);
            Ok(())
        })?;
        if hidden {
            source.check_original_names()?;
        }
        let job = ExportJob {
            id,
            generation: self.current_generation(),
            directory,
            source,
            control,
            outputs: BTreeMap::new(),
            directories: BTreeSet::new(),
            resource_bytes: 0,
            resources: 0,
            sealed: false,
            committing: false,
            committed: None,
            recorded: false,
            target: None,
            _lock: lock,
        };
        let info = job.info();
        self.export = Some(job);
        Ok(info)
    }

    /// 执行受任务编号约束的宿主动作；不对渲染进程暴露此原生能力。
    /// # Errors
    /// 任务失效、路径越界、预算超限、源变化、取消或文件事务失败。
    pub fn export_action(&mut self, id: &str, value: Value, bytes: &[u8]) -> Result<Value> {
        let action: Action = serde_json::from_value(value)
            .map_err(|e| Error::State(format!("导出动作无效：{e}")))?;
        if matches!(action, Action::Acknowledge {}) {
            if self.export.is_some() {
                return Err(Error::State("导出任务尚未释放，不能确认交付".into()));
            }
            let (jobs, _lock) = recovery::lock_jobs(&self.user_data)?;
            recovery::acknowledge(&jobs, id)?;
            return Ok(Value::Null);
        }
        if matches!(action, Action::Discard {} | Action::Preserve {}) && self.export.is_none() {
            return Ok(Value::Null);
        }
        let job = self
            .export
            .as_ref()
            .ok_or_else(|| Error::State("导出任务已结束".into()))?;
        if job.id != id {
            return Err(Error::State("导出任务身份失效".into()));
        }
        // 提交事实不依赖窗口、库代次或取消状态；迟到响应仍须能够核实结果。
        if matches!(action, Action::Outcome {}) {
            return Ok(job.committed.clone().unwrap_or(Value::Null));
        }
        if matches!(action, Action::Discard {} | Action::Preserve {}) {
            let job = self
                .export
                .take()
                .ok_or_else(|| Error::State("导出任务已结束".into()))?;
            if matches!(action, Action::Preserve {}) || (job.committed.is_some() && !job.recorded) {
                let _preserved = job.directory.keep();
                job.source.close()?;
            } else {
                job.source.close()?;
                job.directory.close()?;
            }
            return Ok(Value::Null);
        }
        if !self.matches(job.generation) {
            return Err(Error::State("导出所属笔记库代次已失效".into()));
        }
        self.require_root(&job.source.root().to_string_lossy())?;
        let vault = std::sync::Arc::clone(self.vault()?);
        let job = self
            .export
            .as_mut()
            .ok_or_else(|| Error::State("导出任务已结束".into()))?;
        job.apply(action, bytes, &vault)
    }

    /// 启动时核实尚未交付确认的结果；不要求打开原笔记库，也不重放提交。
    /// # Errors
    /// 活动任务、损坏凭据或文件核验失败时保留记录并返回错误。
    pub fn export_recover(&mut self) -> Result<Value> {
        if self.export.is_some() {
            return Err(Error::State("导出任务正在执行，稍后再检查恢复记录".into()));
        }
        let (jobs, _lock) = recovery::lock_jobs(&self.user_data)?;
        serde_json::to_value(recovery::recover(&jobs)?)
            .map_err(|error| Error::State(error.to_string()))
    }
}

impl ExportJob {
    // 所属窗口和库代次已由 State 验证；本层只执行任务状态允许的文件动作。
    fn apply(
        &mut self,
        action: Action,
        bytes: &[u8],
        vault: &noemori_vault::Vault,
    ) -> Result<Value> {
        self.check()?;
        if self.committing && !matches!(action, Action::Info {}) {
            return Err(Error::State(
                "导出已进入提交边界，不能重复修改或发布".into(),
            ));
        }
        match action {
            Action::Info {} => Ok(self.info()),
            Action::Include { path } => {
                if self.sealed {
                    return Err(Error::State("导出快照已封存".into()));
                }
                self.source
                    .include(vault, &path, &mut |_| check(&self.control))?;
                self.check_budget(0, 0)?;
                Ok(self.info())
            }
            Action::Resolve { from, raw, kind } => {
                let kind: LinkKind = kind
                    .parse()
                    .map_err(|()| Error::State("链接类型无效".into()))?;
                Ok(match self.source.resolve(&from, &raw, kind) {
                    LinkTarget::Resolved { path, anchor } => {
                        json!({"status":"resolved", "path":path, "anchor":anchor})
                    }
                    LinkTarget::Ambiguous { candidates, anchor } => {
                        json!({"status":"ambiguous", "candidates":candidates, "anchor":anchor})
                    }
                    LinkTarget::Dead => json!({"status":"dead"}),
                })
            }
            Action::Seal {} => {
                self.check_budget(0, 0)?;
                self.source.seal(vault, &mut |_| check(&self.control))?;
                self.sealed = true;
                Ok(self.info())
            }
            Action::Copy { source, path } => {
                self.copy(&source, &path)?;
                Ok(Value::Null)
            }
            Action::Write { path, resource } => {
                self.write(&path, bytes, resource)?;
                Ok(Value::Null)
            }
            Action::Directory { path } => {
                fs::create_dir_all(self.output(&path)?)?;
                self.directories.insert(path);
                Ok(Value::Null)
            }
            Action::Target { path } => {
                let target =
                    commit::Target::capture(Path::new(&path), self.source.root(), &self.control)?;
                let exists = target.exists();
                self.target = Some(target);
                Ok(json!({"exists": exists}))
            }
            Action::Publish { single } => commit::publish(self, single.as_deref()),
            Action::Retain { paths } => {
                self.retain(paths)?;
                Ok(Value::Null)
            }
            Action::Discard {}
            | Action::Preserve {}
            | Action::Outcome {}
            | Action::Acknowledge {} => {
                unreachable!("清理与结果核实在校验取消之前处理")
            }
        }
    }

    fn retain(&mut self, paths: Vec<String>) -> Result<()> {
        if paths.iter().any(|path| !self.outputs.contains_key(path)) {
            return Err(Error::State("最终产物清单包含未知文件".into()));
        }
        let keep: std::collections::HashSet<_> = paths.into_iter().collect();
        let removed: Vec<_> = self
            .outputs
            .keys()
            .filter(|path| !keep.contains(*path))
            .cloned()
            .collect();
        for path in removed {
            fs::remove_file(self.output(&path)?)?;
            self.outputs.remove(&path);
        }
        Ok(())
    }

    fn check_budget(&self, files: usize, bytes: u64) -> Result<()> {
        if self.resources + self.source.file_count() + files > EXPORT_FILE_LIMIT
            || self.resource_bytes + self.source.bytes() + bytes > EXPORT_BYTE_LIMIT
        {
            return Err(Error::State(
                "收集资源后超过 10000 文件或 5 GiB 预算".into(),
            ));
        }
        Ok(())
    }
    fn check(&self) -> Result<()> {
        check(&self.control).map_err(Error::from)
    }
    fn info(&self) -> Value {
        json!({"id":self.id, "sourceDirectory":self.source.directory(), "outputDirectory":self.directory.path().join("output"),
            "files":self.source.files(), "directories":self.source.directories(), "bytes":self.source.bytes(), "resourceBytes":self.resource_bytes,"resources":self.resources,"sealed":self.sealed})
    }
    fn output(&self, path: &str) -> Result<PathBuf> {
        let path = Path::new(path);
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(Error::State("导出产物路径必须位于任务内".into()));
        }
        let output = self.directory.path().join("output").join(path);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(output)
    }
    fn reserve(&self, path: &str) -> Result<PathBuf> {
        if self.outputs.contains_key(path) {
            return Err(Error::State(format!("导出产物重复：{path}")));
        }
        let output = self.output(path)?;
        if output.exists() {
            return Err(Error::State(format!("导出产物路径已占用：{path}")));
        }
        Ok(output)
    }
    fn write(&mut self, path: &str, bytes: &[u8], resource: bool) -> Result<()> {
        if resource && self.sealed {
            return Err(Error::State("封存后不能增加源资源".into()));
        }
        if resource && bytes.len() > DOWNLOAD_LIMIT {
            return Err(Error::State("单项网络资源超过 64 MiB".into()));
        }
        let size = u64::try_from(bytes.len()).map_err(|_| Error::State("产物大小无效".into()))?;
        if resource {
            self.check_budget(1, size)?;
        }
        let output = self.reserve(path)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        let digest = export_file_hash(&output, &mut |_| check(&self.control))?;
        self.outputs.insert(path.to_string(), digest);
        if resource {
            self.resource_bytes += size;
            self.resources += 1;
        }
        Ok(())
    }
    fn copy(&mut self, source: &str, path: &str) -> Result<()> {
        let source_path = self.source.file_path(source)?;
        let destination = self.reserve(path)?;
        let mut input = fs::File::open(source_path)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        let mut buffer = vec![0; 64 * 1024];
        loop {
            self.check()?;
            let count = std::io::Read::read(&mut input, &mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
        }
        output.sync_all()?;
        let actual = export_file_hash(&destination, &mut |_| check(&self.control))?;
        let expected = self
            .source
            .file(source)
            .ok_or_else(|| Error::State("导出源不存在".into()))?;
        if actual != (expected.hash.clone(), expected.bytes) {
            return Err(Error::State("复制资源校验失败".into()));
        }
        self.outputs.insert(path.to_string(), actual);
        Ok(())
    }
}

fn cancelled() -> noemori_vault::Error {
    noemori_vault::Error::Io(std::io::Error::other("导出已取消"))
}
fn check(control: &OperationControl) -> std::result::Result<(), noemori_vault::Error> {
    if control.cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "../../../../../test/notes/runtime/integration/export.rs"]
mod tests;
