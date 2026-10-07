use super::super::{
    TerminalNetworkApprover, TerminalNetworkConfig, TerminalNetworkProtocol, TerminalNetworkRule,
};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Approver {
    calls: AtomicUsize,
    entered: tokio::sync::Notify,
    release: tokio::sync::Semaphore,
    decision: Decision,
}
impl Approver {
    fn new(decision: Decision) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Semaphore::new(0),
            decision,
        })
    }
}
#[async_trait::async_trait]
impl TerminalNetworkApprover for Approver {
    async fn approve(
        &self,
        _request: TerminalNetworkApprovalRequest,
        _context: ExecutionContext,
    ) -> Result<Decision, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.release
            .acquire()
            .await
            .map_err(|error| error.to_string())?
            .forget();
        Ok(self.decision.clone())
    }
}
fn request(port: u16, protocol: TerminalNetworkProtocol) -> TerminalNetworkApprovalRequest {
    TerminalNetworkApprovalRequest {
        session_id: "model cannot choose session".into(),
        terminal_id: "terminal".into(),
        call_id: "call".into(),
        command: "curl target".into(),
        workdir: "/workspace".into(),
        target: TerminalNetworkTarget::new("api.example.com", port, protocol).unwrap(),
    }
}

#[tokio::test]
async fn concurrent_requests_share_one_once_decision_but_future_requests_need_new_approval() {
    let session = Arc::new(NetworkSession::default());
    let approver = Approver::new(Decision::AllowOnce);
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig::default())
        .unwrap()
        .with_approver(approver.clone());
    let stop = CancellationToken::new();
    let release = async {
        approver.entered.notified().await;
        approver.release.add_permits(1);
    };
    let (a, b, ()) = tokio::join!(
        session.authorize(&policy, request(443, TerminalNetworkProtocol::Tcp), &stop),
        session.authorize(&policy, request(443, TerminalNetworkProtocol::Tcp), &stop),
        release
    );
    assert!(a.unwrap());
    assert!(b.unwrap());
    assert_eq!(approver.calls.load(Ordering::SeqCst), 1);
    approver.release.add_permits(1);
    assert!(
        session
            .authorize(&policy, request(443, TerminalNetworkProtocol::Tcp), &stop)
            .await
            .unwrap()
    );
    assert_eq!(approver.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn session_grants_are_separate_for_ports_protocols_and_other_conversations() {
    let session = Arc::new(NetworkSession::default());
    let approver = Approver::new(Decision::AllowForSession);
    approver.release.add_permits(10);
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig::default())
        .unwrap()
        .with_approver(approver.clone());
    let stop = CancellationToken::new();
    for (port, protocol) in [
        (443, TerminalNetworkProtocol::Tcp),
        (443, TerminalNetworkProtocol::Tcp),
        (8443, TerminalNetworkProtocol::Tcp),
        (443, TerminalNetworkProtocol::Udp),
    ] {
        assert!(
            session
                .authorize(&policy, request(port, protocol), &stop)
                .await
                .unwrap()
        );
    }
    assert_eq!(approver.calls.load(Ordering::SeqCst), 3);
    assert!(
        Arc::new(NetworkSession::default())
            .authorize(&policy, request(443, TerminalNetworkProtocol::Tcp), &stop)
            .await
            .unwrap()
    );
    assert_eq!(approver.calls.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn static_denial_never_asks_or_reuses_a_dynamic_allow() {
    let session = Arc::new(NetworkSession::default());
    let approver = Approver::new(Decision::AllowForSession);
    approver.release.add_permits(1);
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![TerminalNetworkRule {
            pattern: "*".into(),
            protocols: vec![],
            ports: vec![],
            decision: TerminalNetworkDecision::Deny,
        }],
        ..Default::default()
    })
    .unwrap()
    .with_approver(approver.clone());
    assert!(
        session
            .authorize(
                &policy,
                request(443, TerminalNetworkProtocol::Tcp),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(approver.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancelling_the_first_process_does_not_cancel_other_live_members_of_its_approval_group() {
    let session = Arc::new(NetworkSession::default());
    let approver = Approver::new(Decision::AllowOnce);
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig::default())
        .unwrap()
        .with_approver(approver.clone());
    let first = CancellationToken::new();
    let second = CancellationToken::new();
    let cancel = async {
        approver.entered.notified().await;
        first.cancel();
        tokio::task::yield_now().await;
        approver.release.add_permits(1);
    };
    let (a, b, ()) = tokio::join!(
        session.authorize(&policy, request(443, TerminalNetworkProtocol::Tcp), &first),
        session.authorize(&policy, request(443, TerminalNetworkProtocol::Tcp), &second),
        cancel
    );
    assert!(a.is_err());
    assert!(b.unwrap());
    assert_eq!(approver.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelling_all_requesters_or_closing_the_session_cannot_publish_late_permissions() {
    for close in [false, true] {
        let session = Arc::new(NetworkSession::default());
        let approver = Approver::new(Decision::AllowForSession);
        let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig::default())
            .unwrap()
            .with_approver(approver.clone());
        let stop = CancellationToken::new();
        let cancel = async {
            approver.entered.notified().await;
            if close {
                session.close();
            } else {
                stop.cancel();
            }
            approver.release.add_permits(1);
        };
        let (result, ()) = tokio::join!(
            session.authorize(&policy, request(443, TerminalNetworkProtocol::Tcp), &stop),
            cancel
        );
        assert!(result.is_err());
        tokio::task::yield_now().await;
        assert!(session.data.lock().unwrap().grants.is_empty());
        if close {
            assert!(
                session
                    .authorize(
                        &policy,
                        request(443, TerminalNetworkProtocol::Tcp),
                        &CancellationToken::new()
                    )
                    .await
                    .is_err()
            );
        } else {
            approver.release.add_permits(1);
            assert!(
                session
                    .authorize(
                        &policy,
                        request(443, TerminalNetworkProtocol::Tcp),
                        &CancellationToken::new()
                    )
                    .await
                    .unwrap()
            );
            assert_eq!(approver.calls.load(Ordering::SeqCst), 2);
        }
    }
}
