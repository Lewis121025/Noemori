//! 库生命周期与监视事件的 Node-API 适配。

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use nous_vault::{OpenPhase, Vault};
use crate::runtime::{lock_state, to_napi, AppState};
use crate::entry_batch::ProgressCallback;
use crate::entries::JsVaultEntry;
use std::sync::atomic::{AtomicU8, Ordering};

// 三态区分尚未提交、已提交和已取消，等待线程只能在已提交后刷新。
const WATCH_PENDING: u8 = 0;
const WATCH_ACTIVE: u8 = 1;
const WATCH_CANCELLED: u8 = 2;

#[cfg(test)]
#[path = "../../../../../test/notes/vault-node/unit/watch_notification.rs"]
mod resource_tests;

/// 候选监视器先等待归属确定；取消先唤醒等待者，再回收监视线程。
struct PendingWatch(Arc<AtomicU8>);

impl Drop for PendingWatch {
    fn drop(&mut self) {
        let _ = self.0.compare_exchange(WATCH_PENDING, WATCH_CANCELLED, Ordering::Release, Ordering::Relaxed);
    }
}

/// 开库阶段计数；准备期间可取消，提交会话后的状态替换不可中断。
#[napi(object)]
pub struct JsOpenProgress {
    /// recovering、scanning、checking、reading、indexing、ranking 或 verifying。
    pub phase: String,
    /// 当前阶段已完成条目数。
    pub completed: u32,
    /// 未知总量时缺省，不生成虚构的总体百分比。
    pub total: Option<u32>,
}

/// 监视通知携带受影响路径及健康状态；失败不能伪装成一次成功刷新。
#[napi(object)]
pub struct JsVaultEvent {
    /// changed、watch-error 或 index-error。
    pub status: String,
    /// 已约束到当前库的相对路径，空列表表示需要完整刷新。
    pub paths: Vec<String>,
    /// 本次确实完成了监视后的索引校验。
    pub healthy: bool,
    /// 异常原因；成功事件不提供。
    pub message: Option<String>,
}

/// 打开库并开始监视。
///
/// `root` 是库目录，`index_dir` 是库外的派生索引与恢复目录。
/// 监视线程在防抖与索引刷新后，将 `on_changed` 投递给持有内核的 JS 线程。
/// 成功后替换当前库及其监视器；失败时保留原库。
/// `progress` 返回 false 时取消准备；`before_commit` 接收已准备目录并提交外部会话，
/// 返回 false 同样取消。两个回调都不可重入内核。返回 true 表示已切库，false 表示取消。
///
/// # Errors
///
/// 打不开目录、索引或监视器时失败。
#[napi]
pub fn vault_open(
    root: String,
    index_dir: String,
    on_changed: JsFunction,
    #[napi(ts_arg_type = "((progress: JsOpenProgress) => boolean) | undefined | null")]
    progress: Option<Function<'_, JsOpenProgress, bool>>,
    #[napi(ts_arg_type = "((entries: JsVaultEntry[]) => boolean) | undefined | null")]
    before_commit: Option<Function<'_, Vec<JsVaultEntry>, bool>>,
) -> Result<bool> {
    crate::entry_batch::check_callback_reentry()?;
    let verifying = std::cell::Cell::new(false);
    let mut observer = |item| report_open_progress(progress.as_ref(), item, verifying.get());
    let vault = match Vault::open_with_progress(&root, &index_dir, &mut observer) {
        Ok(vault) => Arc::new(vault),
        Err(nous_vault::Error::OpenCancelled) => return Ok(false),
        Err(error) => return Err(to_napi(error)),
    };
    let activation = Arc::new(AtomicU8::new(WATCH_PENDING));
    let watch = watch_candidate(Arc::clone(&vault), on_changed, Arc::clone(&activation))?;
    // 后于 watch 创建，退出时先释放等待状态，再 join 监视线程。
    let pending_watch = PendingWatch(activation);
    // 先安装监视，再复核扫描期间的变化，消除「扫描结束到开始监视」的空窗。
    verifying.set(true);
    match vault.verify_opening(&mut observer) {
        Ok(()) => {}
        Err(nous_vault::Error::OpenCancelled) => return Ok(false),
        Err(error) => return Err(to_napi(error)),
    }
    // 在提交前验证目录与恢复入口，不能提交后才发现恢复记录不可读。
    let entries = vault
        .list_entries()
        .map_err(to_napi)?
        .into_iter()
        .map(JsVaultEntry::from)
        .collect();
    let mut state = lock_state()?;
    if let Some(commit) = before_commit {
        let _guard = ProgressCallback::enter();
        if !commit.call(entries)? {
            return Ok(false);
        }
    }
    *state = Some(AppState {
        vault,
        _watch: watch,
        search: None,
    });
    pending_watch.0.store(WATCH_ACTIVE, Ordering::Release);
    Ok(true)
}

/// 在调用线程校验计数并报告阶段，禁止 JavaScript 回调重入内核。
fn report_open_progress(
    callback: Option<&Function<'_, JsOpenProgress, bool>>,
    item: nous_vault::OpenProgress,
    verifying: bool,
) -> std::result::Result<bool, nous_vault::Error> {
    let Some(callback) = callback else {
        return Ok(true);
    };
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
    let convert = |count| {
        u32::try_from(count).map_err(|error| nous_vault::Error::Io(std::io::Error::other(error)))
    };
    let _guard = ProgressCallback::enter();
    callback
        .call(JsOpenProgress {
            phase: phase.into(),
            completed: convert(item.completed)?,
            total: item.total.map(convert).transpose()?,
        })
        .map_err(|error| nous_vault::Error::Io(std::io::Error::other(error.to_string())))
}

/// 候选库监视器暂缓实际刷新，取消释放等待状态后即可退出。
fn watch_candidate(
    watched: Arc<Vault>,
    on_changed: JsFunction,
    watching: Arc<AtomicU8>,
) -> Result<nous_vault::WatchHandle> {
    let pending = Arc::new(Mutex::new(crate::watch_events::PendingNotification::default()));
    let delivery = Arc::clone(&pending);
    let tsfn: ThreadsafeFunction<(), ErrorStrategy::Fatal> =
        on_changed.create_threadsafe_function(1, move |_| {
            let event = delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
                .ok_or_else(|| Error::from_reason("缺少待交付的监视通知"))?;
            Ok(vec![event])
        })?;
    // macOS 监视事件会使用 /private/var 等物理路径，比较前只规范化库根，删除事件不能再解析文件。
    let watch_root = std::fs::canonicalize(watched.root())
        .map_err(|error| Error::from_reason(error.to_string()))?;
    let watch = nous_vault::start_watch(
        watch_root.clone(),
        Duration::from_millis(300),
        move |event| {
            while watching.load(Ordering::Acquire) == WATCH_PENDING {
                std::thread::sleep(Duration::from_millis(10));
            }
            if watching.load(Ordering::Acquire) != WATCH_ACTIVE {
                return;
            }
            let notification = watch_notification(&watched, &watch_root, event);
            let schedule = pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(notification);
            if schedule {
                // 一个待交付状态只入队一次；关闭时不能阻塞等待 JS，否则 join 会死锁。
                tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
            }
        },
    )
    .map_err(to_napi)?;
    Ok(watch)
}

/// 监视事件只在库归属确定后刷新索引，读取失败保留具体错误状态。
fn watch_notification(
    watched: &Vault,
    watch_root: &std::path::Path,
    event: std::result::Result<Vec<std::path::PathBuf>, String>,
) -> JsVaultEvent {
    match event {
        Err(mut message) => {
            // 监视错误可能与磁盘变化同批到达；核对最终状态，同时保留监视故障身份。
            if let Err(error) = watched.refresh_index() {
                message.push_str(&format!("；索引复核失败：{error}"));
            }
            JsVaultEvent {
                status: "watch-error".into(),
                paths: Vec::new(),
                healthy: false,
                message: Some(message),
            }
        },
        Ok(paths) => {
            let paths = paths
                .into_iter()
                .filter_map(|path| {
                    path.strip_prefix(watch_root)
                        .ok()
                        .map(nous_vault::path_to_slashes)
                })
                .collect::<std::result::Result<Vec<_>, _>>();
            let (paths, refreshed) = match paths {
                Ok(paths) => (paths, watched.refresh_index()),
                Err(error) => (Vec::new(), Err(error)),
            };
            match refreshed {
                Ok(_) => JsVaultEvent {
                    status: "changed".into(),
                    paths,
                    healthy: true,
                    message: None,
                },
                Err(error) => JsVaultEvent {
                    status: "index-error".into(),
                    paths,
                    healthy: false,
                    message: Some(error.to_string()),
                },
            }
        }
    }
}

/// 关闭当前库并停止监视。
///
/// # Errors
///
/// 锁毒化时失败。
#[napi]
pub fn vault_close() -> Result<()> {
    let mut state = lock_state()?;
    *state = None;
    Ok(())
}
