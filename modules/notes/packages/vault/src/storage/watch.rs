//! 合并磁盘变更通知；事件只使目录失效，真实状态由调用方重新读取。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::Error;

#[cfg(test)]
#[path = "../../../../../../test/notes/vault/unit/storage/watch_resources.rs"]
mod resource_tests;

const MAX_PENDING_PATHS: usize = 1024;
const MAX_PENDING_PATH_BYTES: usize = 256 * 1024;
const MAX_ERROR_BYTES: usize = 2048;

/// 待核对状态有明确容量；空路径通知代表完整核对，不能截断后丢失变化。
#[derive(Default)]
struct PendingChanges {
    paths: BTreeSet<PathBuf>,
    path_bytes: usize,
    full_refresh: bool,
    error: Option<String>,
    deadline: Option<Instant>,
    stopped: bool,
}

impl PendingChanges {
    fn record(&mut self, event: notify::Result<Event>, now: Instant, debounce: Duration) {
        if self.stopped {
            return;
        }
        if let Ok(event) = &event {
            if matches!(event.kind, EventKind::Access(_) | EventKind::Other) && !event.need_rescan()
            {
                return;
            }
        }
        self.deadline.get_or_insert(now + debounce);
        match event {
            Ok(event) => {
                if event.need_rescan() || event.paths.is_empty() {
                    self.require_full_refresh();
                }
                for path in event.paths {
                    if self.full_refresh {
                        break;
                    }
                    if self.paths.contains(&path) {
                        continue;
                    }
                    let bytes = path.as_os_str().len();
                    if self.paths.len() >= MAX_PENDING_PATHS
                        || bytes > MAX_PENDING_PATH_BYTES - self.path_bytes
                    {
                        self.require_full_refresh();
                        break;
                    }
                    self.path_bytes += bytes;
                    self.paths.insert(path);
                }
            }
            Err(error) => {
                self.require_full_refresh();
                if self.error.is_none() {
                    let mut message = error.to_string();
                    let mut end = message.len().min(MAX_ERROR_BYTES);
                    while !message.is_char_boundary(end) {
                        end -= 1;
                    }
                    message.truncate(end);
                    self.error = Some(message);
                }
            }
        }
    }

    fn require_full_refresh(&mut self) {
        self.paths.clear();
        self.path_bytes = 0;
        self.full_refresh = true;
    }

    fn take(&mut self) -> Result<Vec<PathBuf>, String> {
        self.deadline = None;
        self.path_bytes = 0;
        self.full_refresh = false;
        let paths = std::mem::take(&mut self.paths).into_iter().collect();
        // 错误代表变化范围不可信；调用方须完整核对并保留故障提示，不能自行重试成健康通知。
        self.error.take().map_or(Ok(paths), Err)
    }
}

/// 生产者先合并状态再唤醒消费者，刷新阻塞时也不会堆积事件对象。
#[derive(Default)]
struct WatchQueue {
    pending: Mutex<PendingChanges>,
    ready: Condvar,
}

impl WatchQueue {
    fn push(&self, event: notify::Result<Event>, debounce: Duration) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.record(event, Instant::now(), debounce);
        self.ready.notify_one();
    }

    fn stop(&self) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stopped = true;
        self.ready.notify_one();
    }

    fn next(&self) -> Option<Result<Vec<PathBuf>, String>> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if pending.stopped {
                return None;
            }
            if let Some(deadline) = pending.deadline {
                let now = Instant::now();
                if now >= deadline {
                    return Some(pending.take());
                }
                (pending, _) = self
                    .ready
                    .wait_timeout(pending, deadline - now)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            } else {
                pending = self
                    .ready
                    .wait(pending)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
        }
    }
}

/// 持有系统监视器与合并线程；释放时等待回调结束，之后不再通知调用方。
pub struct WatchHandle {
    _watcher: RecommendedWatcher,
    queue: Arc<WatchQueue>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        // 停止不排在普通变化后；正在执行的回调结束后直接退出。
        self.queue.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 递归监视 `root`，将一个 `debounce` 时间窗内的变化合并成去重路径集合。
///
/// 不推断创建/删除/改名的最终语义：macOS 可合并历史标志，抵消事件会漏掉真实删除。
/// 时间窗从首条通知开始，持续写入不会无限推迟刷新。回调在独立线程执行，须自行处理锁。
/// 路径数量或字节超限时返回空路径集合，调用方必须完整核对；错误同样表示全库失效。
/// # Errors
/// 库根不存在、无法启动系统监视器或合并线程时返回 IO 错误。
pub fn start_watch<F>(
    root: impl AsRef<Path>,
    debounce: Duration,
    on_change: F,
) -> Result<WatchHandle, Error>
where
    F: Fn(Result<Vec<PathBuf>, String>) + Send + 'static,
{
    let root = std::fs::canonicalize(root)?;
    let queue = Arc::new(WatchQueue::default());
    let events = Arc::clone(&queue);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        events.push(event, debounce);
    })
    .map_err(|error| Error::Io(std::io::Error::other(error)))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| Error::Io(std::io::Error::other(error)))?;
    let processing = Arc::clone(&queue);
    let thread = thread::Builder::new()
        .name("noemori-vault-watch".into())
        .spawn(move || {
            while let Some(event) = processing.next() {
                on_change(event);
            }
        })?;
    Ok(WatchHandle {
        _watcher: watcher,
        queue,
        thread: Some(thread),
    })
}
