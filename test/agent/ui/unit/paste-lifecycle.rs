#[path = "../../../../modules/agent/macos-ui/src/paste-lifecycle.rs"]
mod lifecycle;
use lifecycle::{PasteClipboard, PasteTarget, PendingPaste, SettlementReason};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
struct TargetState {
    alive: bool,
    text: String,
    error: Option<String>,
}
struct Target(Rc<RefCell<TargetState>>);
impl PasteTarget for Target {
    fn alive(&self) -> bool {
        self.0.borrow().alive
    }
    fn text(&self) -> Result<String, String> {
        let state = self.0.borrow();
        state
            .error
            .clone()
            .map_or_else(|| Ok(state.text.clone()), Err)
    }
}
#[derive(Default)]
struct ClipboardState {
    owned: bool,
    restored: usize,
    failures: usize,
    original: Vec<u8>,
    current: Vec<u8>,
}
struct Clipboard(Rc<RefCell<ClipboardState>>);
impl PasteClipboard for Clipboard {
    fn owned(&self) -> bool {
        self.0.borrow().owned
    }
    fn restore(&mut self) -> Result<bool, String> {
        let mut state = self.0.borrow_mut();
        if state.failures > 0 {
            state.failures -= 1;
            return Err("系统恢复失败".into());
        }
        state.restored += 1;
        state.current = state.original.clone();
        Ok(true)
    }
}
struct Fixture {
    pending: PendingPaste<Target, Clipboard>,
    target: Rc<RefCell<TargetState>>,
    clipboard: Rc<RefCell<ClipboardState>>,
}
fn fixture() -> Fixture {
    let target = Rc::new(RefCell::new(TargetState {
        alive: true,
        text: "before".into(),
        error: None,
    }));
    let clipboard = Rc::new(RefCell::new(ClipboardState {
        owned: true,
        original: vec![0, 255, 5],
        current: b"payload".to_vec(),
        ..Default::default()
    }));
    Fixture {
        pending: PendingPaste::new(
            Target(target.clone()),
            Clipboard(clipboard.clone()),
            "after".into(),
            "transaction".into(),
            "session".into(),
        ),
        target,
        clipboard,
    }
}

#[test]
fn late_consumption_keeps_payload_until_real_ack() {
    let Fixture {
        mut pending,
        target,
        clipboard,
    } = fixture();
    assert!(pending.poll().unwrap().is_none());
    assert_eq!(clipboard.borrow().restored, 0);
    assert_eq!(clipboard.borrow().current, b"payload");
    target.borrow_mut().text = "after".into();
    let settled = pending.poll().unwrap().unwrap();
    assert_eq!(settled.reason, SettlementReason::Acknowledged);
    assert!(settled.clipboard_restored);
    assert_eq!(clipboard.borrow().current, vec![0, 255, 5]);
}

#[test]
fn cancellation_and_release_do_not_restore_before_consumption() {
    let Fixture {
        mut pending,
        target,
        clipboard,
    } = fixture();
    pending.interrupted("调用取消/会话释放/连接断开".into());
    for _ in 0..10 {
        assert!(pending.poll().unwrap().is_none());
    }
    assert_eq!(clipboard.borrow().restored, 0);
    assert_eq!(pending.token(), "transaction");
    assert_eq!(pending.session(), "session");
    target.borrow_mut().text = "after".into();
    let settled = pending.poll().unwrap().unwrap();
    assert!(settled.interrupted.is_some());
    assert_eq!(settled.reason.name(), "acknowledged");
}

#[test]
fn ownership_loss_after_timeout_preserves_user_data() {
    let Fixture {
        mut pending,
        clipboard,
        ..
    } = fixture();
    assert!(pending.poll().unwrap().is_none());
    clipboard.borrow_mut().owned = false;
    clipboard.borrow_mut().current = b"user new clipboard".to_vec();
    let settled = pending.poll().unwrap().unwrap();
    assert_eq!(settled.reason, SettlementReason::OwnershipLost);
    assert!(!settled.clipboard_restored);
    assert_eq!(clipboard.borrow().restored, 0);
    assert_eq!(clipboard.borrow().current, b"user new clipboard");
}

#[test]
fn target_exit_safely_restores_without_claiming_ack() {
    let Fixture {
        mut pending,
        target,
        clipboard,
    } = fixture();
    target.borrow_mut().alive = false;
    let settled = pending.poll().unwrap().unwrap();
    assert_eq!(settled.reason, SettlementReason::TargetExited);
    assert_eq!(clipboard.borrow().restored, 1);
}

#[test]
fn probe_and_restore_failure_keep_original_materials_for_safe_retry() {
    let Fixture {
        mut pending,
        target,
        clipboard,
    } = fixture();
    target.borrow_mut().error = Some("目标无响应".into());
    assert!(pending.poll().unwrap().is_none());
    assert_eq!(pending.error(), Some("目标无响应"));
    target.borrow_mut().error = None;
    target.borrow_mut().text = "after".into();
    clipboard.borrow_mut().failures = 1;
    assert_eq!(pending.poll().unwrap_err(), "系统恢复失败");
    assert_eq!(clipboard.borrow().original, vec![0, 255, 5]);
    assert!(pending.poll().unwrap().unwrap().clipboard_restored);
}

#[test]
fn recovery_after_no_key_dispatch_retries_cleanup_without_waiting_for_text() {
    let Fixture {
        target, clipboard, ..
    } = fixture();
    let mut recovery = PendingPaste::recovery(
        Target(target),
        Clipboard(clipboard.clone()),
        "recovery".into(),
        "session".into(),
        "按键未派发，但第一次恢复失败".into(),
    );
    let settled = recovery.poll().unwrap().unwrap();
    assert_eq!(settled.reason, SettlementReason::NotDispatched);
    assert_eq!(clipboard.borrow().restored, 1);
}

#[test]
fn acknowledged_consumption_survives_restore_failure_and_later_user_edit() {
    let Fixture {
        mut pending,
        target,
        clipboard,
    } = fixture();
    target.borrow_mut().text = "after".into();
    clipboard.borrow_mut().failures = 1;
    assert!(pending.poll().is_err());
    target.borrow_mut().text = "用户在已完成粘贴后继续编辑".into();
    let settled = pending
        .poll()
        .unwrap()
        .expect("已经确认的消费不能因后续文字变化而失效");
    assert_eq!(settled.reason, SettlementReason::Acknowledged);
    assert!(settled.clipboard_restored);
    assert_eq!(settled.error.as_deref(), Some("系统恢复失败"));
}

#[test]
fn user_override_after_ack_preserves_both_ack_fact_and_new_clipboard() {
    let Fixture {
        mut pending,
        target,
        clipboard,
    } = fixture();
    target.borrow_mut().text = "after".into();
    clipboard.borrow_mut().failures = 1;
    assert!(pending.poll().is_err());
    clipboard.borrow_mut().owned = false;
    clipboard.borrow_mut().current = b"new user data".to_vec();
    let settled = pending.poll().unwrap().unwrap();
    assert!(settled.acknowledged);
    assert_eq!(settled.reason, SettlementReason::OwnershipLost);
    assert_eq!(clipboard.borrow().current, b"new user data");
}
