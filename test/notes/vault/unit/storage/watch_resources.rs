//! 直接注入事件和阻塞回调，避免依赖不同系统的文件监视合并频率。

use super::*;
use std::sync::{mpsc, Arc};

fn change(path: impl Into<PathBuf>) -> Event {
    Event::new(EventKind::Any).add_path(path.into())
}

#[test]
fn resource_watch_deduplicates_before_dispatch_and_keeps_first_deadline() {
    let mut pending = PendingChanges::default();
    let now = Instant::now();
    for offset in 0..100_000 {
        pending.record(
            Ok(change("same.md")),
            now + Duration::from_micros(offset),
            Duration::from_secs(1),
        );
    }
    assert_eq!(pending.paths.len(), 1);
    assert_eq!(pending.deadline, Some(now + Duration::from_secs(1)));
    assert_eq!(pending.take(), Ok(vec![PathBuf::from("same.md")]));
    assert!(pending.deadline.is_none());
}

#[test]
fn resource_watch_overflow_becomes_one_full_refresh_without_retaining_paths() {
    let mut pending = PendingChanges::default();
    let now = Instant::now();
    for index in 0..100_000 {
        pending.record(Ok(change(format!("{index}.md"))), now, Duration::ZERO);
        assert!(pending.paths.len() <= MAX_PENDING_PATHS);
        assert!(pending.path_bytes <= MAX_PENDING_PATH_BYTES);
    }
    assert!(pending.paths.is_empty());
    assert_eq!(pending.take(), Ok(Vec::new()));
    pending.record(Ok(change("latest.md")), now, Duration::ZERO);
    assert_eq!(pending.take(), Ok(vec![PathBuf::from("latest.md")]));
}

#[test]
fn resource_watch_bounds_path_bytes_and_error_diagnostics_without_losing_invalidation() {
    let mut pending = PendingChanges::default();
    let now = Instant::now();
    pending.record(
        Ok(change("x".repeat(MAX_PENDING_PATH_BYTES + 1))),
        now,
        Duration::ZERO,
    );
    pending.record(
        Err(notify::Error::generic(&"错误".repeat(10_000))),
        now,
        Duration::ZERO,
    );
    for _ in 0..100 {
        pending.record(Err(notify::Error::generic("再次失败")), now, Duration::ZERO);
    }
    let message = pending.take().unwrap_err();
    assert!(!message.is_empty());
    assert!(message.len() <= MAX_ERROR_BYTES);
    assert!(pending.paths.is_empty());
    assert!(pending.deadline.is_none(), "监视错误不能自行重试成健康通知");
}

#[test]
fn resource_watch_stop_bypasses_pending_work_and_joins_current_callback() {
    let queue = Arc::new(WatchQueue::default());
    let worker_queue = Arc::clone(&queue);
    let (entered, began) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut calls = 0;
        while let Some(_batch) = worker_queue.next() {
            calls += 1;
            entered.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        calls
    });
    queue.push(Ok(change("first.md")), Duration::ZERO);
    began.recv_timeout(Duration::from_secs(3)).unwrap();
    for number in 0..10_000 {
        queue.push(Ok(change(format!("{number}.md"))), Duration::ZERO);
    }
    queue.stop();
    release.send(()).unwrap();
    assert_eq!(worker.join().unwrap(), 1, "停止后不能继续消费旧任务");
}

#[test]
fn resource_watch_events_during_refresh_survive_into_next_batch() {
    let queue = WatchQueue::default();
    queue.push(Ok(change("first.md")), Duration::ZERO);
    assert_eq!(queue.next().unwrap(), Ok(vec![PathBuf::from("first.md")]));
    queue.push(Ok(change("second.md")), Duration::ZERO);
    assert_eq!(queue.next().unwrap(), Ok(vec![PathBuf::from("second.md")]));
    queue.stop();
    assert!(queue.next().is_none());
}
