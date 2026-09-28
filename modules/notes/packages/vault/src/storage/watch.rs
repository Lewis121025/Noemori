//! 合并磁盘变更通知；事件只使目录失效，真实状态由调用方重新读取。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::Error;

enum WatchMessage {
    Change(notify::Result<Event>),
    Stop,
}

/// 持有系统监视器与合并线程；释放时等待回调结束，之后不再通知调用方。
pub struct WatchHandle {
    _watcher: RecommendedWatcher,
    sender: Sender<WatchMessage>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        // 接收端已经退出时无需再次停止；回调不持有此句柄，不会等待自身。
        let _ = self.sender.send(WatchMessage::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 递归监视 `root`，将一个 `debounce` 时间窗内的变化合并成去重路径集合。
///
/// 不推断创建/删除/改名的最终语义：macOS 可合并历史标志，抵消事件会漏掉真实删除。
/// 时间窗从首条通知开始，持续写入不会无限推迟刷新。回调在独立线程执行，须自行处理锁。
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
    let (sender, receiver) = mpsc::channel();
    let events = sender.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if let Ok(event) = &event {
            // 读取目录与索引会产生访问事件，不能让刷新再次触发自身。
            if matches!(event.kind, EventKind::Access(_) | EventKind::Other) && !event.need_rescan()
            {
                return;
            }
        }
        let _ = events.send(WatchMessage::Change(event));
    })
    .map_err(|error| Error::Io(std::io::Error::other(error)))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| Error::Io(std::io::Error::other(error)))?;
    let thread = thread::Builder::new()
        .name("nous-vault-watch".into())
        .spawn(move || dispatch_changes(&receiver, debounce, on_change))?;
    Ok(WatchHandle {
        _watcher: watcher,
        sender,
        thread: Some(thread),
    })
}

fn dispatch_changes(
    receiver: &Receiver<WatchMessage>,
    debounce: Duration,
    on_change: impl Fn(Result<Vec<PathBuf>, String>),
) {
    let mut deadline: Option<Instant> = None;
    let mut paths = BTreeSet::new();
    let mut errors = Vec::new();
    loop {
        let message = match deadline {
            Some(at) if Instant::now() >= at => Err(RecvTimeoutError::Timeout),
            Some(at) => receiver.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match message {
            Ok(WatchMessage::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(WatchMessage::Change(event)) => {
                deadline.get_or_insert_with(|| Instant::now() + debounce);
                match event {
                    Ok(event) => paths.extend(event.paths),
                    Err(error) => errors.push(error.to_string()),
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                deadline = None;
                let changed = std::mem::take(&mut paths).into_iter().collect();
                if errors.is_empty() {
                    on_change(Ok(changed));
                } else {
                    on_change(Err(std::mem::take(&mut errors).join("；")));
                }
            }
        }
    }
}
