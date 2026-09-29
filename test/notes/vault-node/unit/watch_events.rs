//! JS 线程阻塞时只保留一个有界通知，错误不能被后续成功事件覆盖。

use super::*;

fn event(paths: &[&str]) -> JsVaultEvent {
    JsVaultEvent {
        status: "changed".into(),
        paths: paths.iter().map(|path| (*path).into()).collect(),
        healthy: true,
        message: None,
    }
}

#[test]
fn resource_notifications_schedule_once_and_merge_paths() {
    let mut pending = PendingNotification::default();
    assert!(pending.push(event(&["first.md"])));
    for _ in 0..100_000 {
        assert!(!pending.push(event(&["last.md"])));
    }
    let taken = pending.take().unwrap();
    assert_eq!(taken.paths, ["first.md", "last.md"]);
    assert!(pending.push(event(&["next.md"])));
}

#[test]
fn resource_notification_overflow_preserves_full_refresh_and_error() {
    let mut pending = PendingNotification::default();
    let mut failure = event(&["first.md"]);
    failure.status = "index-error".into();
    failure.healthy = false;
    failure.message = Some("索引失败".into());
    pending.push(failure);
    for number in 0..10_000 {
        pending.push(event(&[&format!("{number}.md")]));
    }
    let taken = pending.take().unwrap();
    assert!(taken.paths.is_empty());
    assert!(!taken.healthy);
    assert_eq!(taken.status, "index-error");
    assert_eq!(taken.message.as_deref(), Some("索引失败"));
}

#[test]
fn resource_notifications_bound_large_single_payloads() {
    let mut pending = PendingNotification::default();
    let mut large = event(&[&"x".repeat(MAX_PATH_BYTES + 1)]);
    large.message = Some("错误".repeat(10_000));
    pending.push(large);
    let taken = pending.take().unwrap();
    assert!(taken.paths.is_empty());
    assert!(taken.message.unwrap().len() <= MAX_MESSAGE_BYTES);
}
