#![cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "../../support/model.rs"]
mod model;
use noemori_agent::{
    host::{DesktopSession, DesktopSessionOptions, HostApprovalReply, HostRunStatus},
    llm::ModelEvent,
    tool::terminal::TerminalApprovalDecision,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};

async fn wait(
    host: &DesktopSession,
    condition: impl Fn(&noemori_agent::host::HostSnapshot) -> bool,
) -> noemori_agent::host::HostSnapshot {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = host.snapshot();
            if condition(&snapshot) {
                return snapshot;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn desktop_session_commits_closed_history_and_retains_terminal_output_for_an_independent_reader()
 {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("note.txt"), "needle\n").unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[(
            "search",
            "terminal",
            json!({"action":"exec","cmd":"rg -n needle note.txt","yield_time_ms":5000}),
        )])],
        vec![
            Ok(ModelEvent::TextDelta("完成".into())),
            model::answer("完成"),
        ],
        vec![model::answer("下一轮")],
    ]));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start("搜索文件".into()).unwrap();
    let snapshot = wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(
        snapshot.messages.last().unwrap().content,
        noemori_agent::Message::text(noemori_agent::Role::Assistant, "完成").content
    );
    assert_eq!(snapshot.terminals.len(), 1);
    let page = host
        .read_terminal(&snapshot.terminals[0].process.session_id, 0, 8192)
        .await
        .unwrap();
    let bytes: Vec<_> = page
        .chunks
        .iter()
        .flat_map(|chunk| {
            base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                &chunk.data_base64,
            )
            .unwrap()
        })
        .collect();
    assert_eq!(bytes, b"1:needle\n");
    host.start("继续".into()).unwrap();
    wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        noemori_agent::validate_history(&requests[2].messages).unwrap();
    }
    host.close().await.unwrap();
    assert!(host.snapshot().closed);
    assert!(host.start("已关闭".into()).is_err());
}

#[tokio::test]
async fn cancelling_an_approval_removes_it_and_late_consent_cannot_execute_the_command() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let secret = root.path().join("secret");
    std::fs::write(&secret, "outside").unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::calls(&[(
        "approval",
        "terminal",
        json!({"action":"exec","cmd":"touch should-not-run","permission_request":{"reason":"读取外部文件","readable_paths":[secret]}}),
    )])]]));
    let host = DesktopSession::new(
        model,
        DesktopSessionOptions::new(&workspace),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start("执行".into()).unwrap();
    let pending = wait(&host, |snapshot| !snapshot.approvals.is_empty()).await;
    let approval = pending.approvals[0].id.clone();
    host.cancel();
    wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Cancelled)
    })
    .await;
    assert!(host.snapshot().approvals.is_empty());
    assert!(
        host.resolve_approval(
            &approval,
            HostApprovalReply::Terminal(TerminalApprovalDecision::AllowOnce)
        )
        .is_err()
    );
    assert!(!workspace.join("should-not-run").exists());
    host.close().await.unwrap();
}

#[tokio::test]
async fn closing_a_desktop_session_reaps_background_terminals_after_the_model_run_has_finished() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[(
            "background",
            "terminal",
            json!({"action":"exec","cmd":"printf ready; sleep 30","yield_time_ms":0}),
        )])],
        vec![model::answer("后台已启动")],
    ]));
    let host = DesktopSession::new(
        model,
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start("后台".into()).unwrap();
    wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(host.snapshot().terminals.len(), 1);
    host.close().await.unwrap();
    assert!(
        host.snapshot()
            .terminals
            .iter()
            .all(|terminal| terminal.process.status
                != noemori_agent::tool::terminal::TerminalStatus::Running)
    );
}
