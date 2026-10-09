//! 应用状态只由顺序通道修改；开库提交点之前不改变现有库与会话。

use crate::{session::SessionStore, watch::WatchedVault, Error, OperationControl, Result};
use noemori_vault::{OpenPhase, Vault};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

/// 归属于特定库代次的通知；宿主交付时仍须核对代次。
#[derive(Clone, Debug, Serialize)]
pub struct VaultEvent {
    /// 生命周期代次，仅供原生适配过滤迟到通知。
    pub generation: u64,
    /// changed、watch-error 或 index-error。
    pub status: String,
    /// 库内相对路径，空数组表示全部刷新。
    pub paths: Vec<String>,
    /// 本次是否完成索引核对。
    pub healthy: bool,
    /// 故障原因，正常通知省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 顺序通道拥有的应用状态；不暴露跨线程可变库句柄。
pub struct State {
    pub(crate) user_data: PathBuf,
    pub(crate) export: Option<crate::export::ExportJob>,
    /// 会话操作必须通过同一顺序通道调用。
    pub sessions: SessionStore,
    active: Option<WatchedVault>,
    generation: Arc<AtomicU64>,
    sequence: u64,
    search: crate::scheduler::ScopedReadSession,
    model: crate::scheduler::ScopedReadSession,
    publisher: crate::publication::Publisher,
    notify: Arc<dyn Fn(VaultEvent) + Send + Sync>,
}

/// 恢复资料库时的阅读现场与未提交草稿，在发布新库前一并准备。
pub(crate) struct Restoration {
    pub reader: Value,
    pub drafts: Vec<(String, noemori_vault::Draft)>,
}

impl State {
    pub(crate) fn new(
        user_data: PathBuf,
        generation: Arc<AtomicU64>,
        notify: Arc<dyn Fn(VaultEvent) + Send + Sync>,
        search: crate::scheduler::ScopedReadSession,
        model: crate::scheduler::ScopedReadSession,
        publisher: crate::publication::Publisher,
    ) -> Self {
        Self {
            sessions: SessionStore::new(&user_data),
            user_data,
            export: None,
            active: None,
            generation,
            sequence: 0,
            notify,
            search,
            model,
            publisher,
        }
    }

    pub(crate) fn matches(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Acquire) == generation
    }

    /// 长生命周期任务绑定库代次；重新打开同一路径也不能复用旧任务。
    pub(crate) fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// 当前库只在顺序通道内取得；未打开时返回错误。
    /// # Errors
    /// 未打开库。
    pub fn vault(&self) -> Result<&Arc<Vault>> {
        self.active
            .as_ref()
            .map(|a| &a.vault)
            .ok_or_else(|| Error::State("尚未打开库".into()))
    }

    /// 校验带库根的请求，阻止旧窗口对新库执行批量或附件操作。
    /// # Errors
    /// 当前库与请求不一致。
    pub fn require_root(&self, root: &str) -> Result<()> {
        if self
            .active
            .as_ref()
            .is_none_or(|active| active.vault.root() != std::path::Path::new(root))
        {
            return Err(Error::State("笔记库已切换，请重新选择条目".into()));
        }
        Ok(())
    }

    /// 准备、验证并提交候选库；取消返回 null，失败保留旧状态。
    /// # Errors
    /// 扫描、监听、会话提交失败均在切换前传播。
    pub fn open(&mut self, root: &str, restore: bool, control: &OperationControl) -> Result<Value> {
        let restoration = restore.then(|| Restoration {
            reader: self.sessions.load()["reader"].clone(),
            drafts: Vec::new(),
        });
        self.open_restoring(root, control, restoration)
    }

    pub(crate) fn index_directory(&self, root: &str) -> PathBuf {
        let hash = Sha256::digest(root.as_bytes()).iter().take(8).fold(
            String::with_capacity(16),
            |mut text, byte| {
                use std::fmt::Write as _;
                let _ = write!(text, "{byte:02x}");
                text
            },
        );
        self.user_data.join("vaults").join(&hash[..16])
    }

    pub(crate) fn open_restoring(&mut self, root: &str, control: &OperationControl, restoration: Option<Restoration>) -> Result<Value> {
        let index = self.index_directory(root);
        let report = |item: noemori_vault::OpenProgress, verifying: bool| {
            let phase = if verifying {
                "verifying"
            } else {
                match item.phase {
                    OpenPhase::Recovering => "recovering",
                    OpenPhase::Scanning => "scanning",
                    OpenPhase::Checking => "checking",
                    OpenPhase::Reading => "reading",
                    OpenPhase::Indexing => "indexing",
                    OpenPhase::Ranking => "ranking",
                }
            };
            control.update(phase, item.completed, item.total);
            Ok(!control.cancelled())
        };
        let vault = match Vault::open_with_progress(root, &index, &mut |item| report(item, false)) {
            Ok(vault) => Arc::new(vault),
            Err(noemori_vault::Error::OpenCancelled) => return Ok(Value::Null),
            Err(error) => return Err(error.into()),
        };
        vault.configure_search_model(&self.user_data.join("models"))?;
        if let Some(restoration) = &restoration {
            for (path, draft) in &restoration.drafts {
                vault.restore_draft(path, draft)?;
            }
        }
        self.sequence += 1;
        let generation = self.sequence;
        let candidate = WatchedVault::new(
            vault,
            generation,
            Arc::clone(&self.notify),
            self.publisher.clone(),
        )?;
        match candidate
            .vault
            .verify_opening(&mut |item| report(item, true))
        {
            Ok(()) => {}
            Err(noemori_vault::Error::OpenCancelled) => return Ok(Value::Null),
            Err(error) => return Err(error.into()),
        }
        let entries: Vec<_> = candidate.vault.list_entries()?.into_iter().map(|entry| {
            let mut value = json!({"path": entry.path, "kind": if entry.kind == noemori_vault::EntryKind::File { "file" } else { "directory" }});
            if entry.recovery_only { value["recoveryOnly"] = json!(true); }
            if let Some(time) = entry.modified_at { value["modifiedAt"] = json!(time); }
            value
        }).collect();
        if !control.commit() {
            return Ok(Value::Null);
        }
        let mut result = json!({"root": root, "entries": entries});
        if let Some(mut restoration) = restoration {
            restoration.reader["vaultRoot"] = json!(root);
            self.sessions.patch_reader(&restoration.reader)?;
            for key in ["documents", "viewModes", "recentFiles", "fileTree"] {
                result[key] = restoration.reader[key].clone();
            }
        } else {
            self.sessions.patch_reader(&json!({"vaultRoot": root, "documents": crate::session::empty_documents(), "viewModes": {}, "recentFiles": [], "fileTree": null}))?;
        }
        self.cancel_read_tasks();
        self.generation.store(generation, Ordering::Release);
        self.active = Some(candidate);
        // 旧监听器已 join，才能清掉它最后提交的排名请求；否则队列会长期保留旧 Vault。
        self.publisher.clear();
        if let Some(active) = &self.active {
            active.activate();
            active.publish(&self.publisher);
        }
        Ok(result)
    }

    /// 创建系统默认目录后沿用同一开库事务；已存在的目录不覆盖内容。
    /// # Errors
    /// 目录创建或开库失败，不替换已打开的库。
    pub fn create(&mut self, root: &str, control: &OperationControl) -> Result<Value> {
        if control.cancelled() {
            return Ok(Value::Null);
        }
        if self.active.as_ref().is_some_and(|active| active.vault.root() == std::path::Path::new(root)) {
            return self.open(root, true, control);
        }
        std::fs::create_dir_all(root)?;
        self.open(root, false, control)
    }

    /// 恢复上次目录；目录不可达时保留原会话并报告可重试错误。
    /// # Errors
    /// 目录不可达或开库失败。
    pub fn restore(&mut self, control: &OperationControl) -> Result<Value> {
        let session = self.sessions.load();
        let Some(root) = session["reader"]["vaultRoot"].as_str() else {
            return Ok(Value::Null);
        };
        if !std::path::Path::new(root).is_dir() {
            return Err(Error::State(format!(
                "上次的资料目录无法访问：{root}。请恢复目录后重试，或打开其他资料库。"
            )));
        }
        self.open(root, true, control)
    }

    /// 释放监听与库；必须在阻塞线程执行，join 不能占用宿主事件循环。
    /// # Errors
    /// 当前实现无额外失败点，保留结果用于停机契约。
    pub fn close(&mut self) -> Result<()> {
        self.cancel_read_tasks();
        // 无活动库也是新的生命周期阶段；回到 0 会让迟到通知的代次排序失效。
        self.sequence += 1;
        self.generation.store(self.sequence, Ordering::Release);
        self.active = None;
        self.publisher.clear();
        Ok(())
    }

    pub(crate) fn failed(&self) {
        (self.notify)(VaultEvent {
            generation: self.generation.load(Ordering::Acquire),
            status: "worker-error".into(),
            paths: Vec::new(),
            healthy: false,
            message: Some("内核任务异常，写入结果未知，请重新启动应用".into()),
        });
    }

    pub(crate) fn schedule_publication(&self) {
        if let Some(active) = &self.active {
            active.publish(&self.publisher);
        }
    }

    fn cancel_read_tasks(&self) {
        crate::scheduler::cancel_session(&self.search, None);
        crate::scheduler::cancel_session(&self.model, None);
    }

    /// 文件提交之后更新会话；失败仅追加警告，不能把成功操作重新列入重试。
    #[must_use]
    pub fn remember_change(
        &self,
        warning: Option<String>,
        from: &str,
        to: Option<&str>,
    ) -> Option<String> {
        let mut messages: Vec<String> = warning.into_iter().collect();
        if let Err(error) = self.sessions.remap(from, to) {
            messages.push(format!("文件操作已完成，会话更新失败：{error}"));
        }
        (!messages.is_empty()).then(|| messages.join("；"))
    }

    /// 发布已提交变更；健康标记不伪装成已经完成外部文件核对。
    pub fn changed(&self, paths: Vec<String>, healthy: bool) {
        self.schedule_publication();
        (self.notify)(VaultEvent {
            generation: self.generation.load(Ordering::Acquire),
            status: "changed".into(),
            paths,
            healthy,
            message: None,
        });
    }
}
