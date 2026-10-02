//! 验证取消与提交的互斥边界，快照从不暴露半个更新。
use super::*;

#[test]
fn cancellation_wins_before_commit_and_loses_after_commit() {
    let control = OperationControl::default();
    let other = control.clone();
    other.update("reading", 10, Some(100));
    assert_eq!(control.progress().completed, 10);
    assert!(control.cancel());
    assert!(other.cancelled());
    assert!(!other.commit());
    let control = OperationControl::default();
    assert!(control.commit());
    assert!(!control.cancel());
    assert!(!control.cancelled());
    assert_eq!(control.progress().phase, "committing");
}
