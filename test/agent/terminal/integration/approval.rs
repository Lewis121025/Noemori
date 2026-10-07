use super::{call, ready};
use async_trait::async_trait;
use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, ToolCall,
    tool::{
        ToolRegistry,
        terminal::{
            SandboxConfig, SandboxMode, TerminalApprovalDecision, TerminalApprovalRequest,
            TerminalApprover, TerminalTool, WorkspaceAccess,
        },
    },
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[path = "approval_reuse.rs"]
mod reuse_tests;

#[path = "command_policy.rs"]
mod policy_tests;

struct Approver {
    decision: Option<TerminalApprovalDecision>,
    requests: Mutex<Vec<TerminalApprovalRequest>>,
    entered: tokio::sync::Notify,
}

impl Approver {
    fn new(decision: Option<TerminalApprovalDecision>) -> Arc<Self> {
        Arc::new(Self {
            decision,
            requests: Mutex::new(Vec::new()),
            entered: tokio::sync::Notify::new(),
        })
    }
}

#[async_trait]
impl TerminalApprover for Approver {
    async fn approve(
        &self,
        request: TerminalApprovalRequest,
        context: ExecutionContext,
    ) -> Result<TerminalApprovalDecision, String> {
        self.requests.lock().unwrap().push(request);
        self.entered.notify_one();
        match &self.decision {
            Some(decision) => Ok(decision.clone()),
            None => context
                .wait(std::future::pending())
                .await
                .map_err(|e| e.to_string()),
        }
    }
}

#[tokio::test]
async fn missing_or_denied_approval_never_dispatches_the_command() {
    let workspace = tempfile::tempdir().unwrap();
    for approver in [
        None,
        Some(Approver::new(Some(TerminalApprovalDecision::Deny(
            "host rejected".into(),
        )))),
    ] {
        let mut tool = TerminalTool::with_shell(workspace.path(), "/bin/sh").unwrap();
        if let Some(approver) = approver {
            tool = tool.with_approver(approver);
        }
        let mut tools = ToolRegistry::new();
        tools.register(tool).unwrap();
        let session = AgentSession::new();
        let result = call(&tools, &session, json!({"action":"exec", "cmd":"touch dispatched", "permission_request":{"reason":"connect to dependency server", "network":true}})).await;
        assert!(result.is_error, "{result:?}");
        assert!(!workspace.path().join("dispatched").exists());
        assert_eq!(
            call(&tools, &session, json!({"action":"list"}))
                .await
                .output,
            json!({"terminals":[]})
        );
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn approval_is_bound_to_one_process_and_its_interactions() {
    let workspace = tempfile::tempdir().unwrap();
    let grant_link = workspace.path().join("grant-link");
    std::os::unix::fs::symlink(workspace.path(), &grant_link).unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowOnce));
    let tool = TerminalTool::configured(
        workspace.path(),
        "/bin/sh",
        SandboxMode::Restricted(SandboxConfig {
            workspace_access: WorkspaceAccess::ReadOnly,
            ..Default::default()
        }),
    )
    .unwrap()
    .with_approver(approver.clone());
    let mut tools = ToolRegistry::new();
    tools.register(tool).unwrap();
    let session = AgentSession::new();
    let command = "stty -echo; printf ready; read value; printf '%s' \"$value\" > approved";
    let first = call(&tools, &session, json!({"action":"exec", "cmd":command,"tty":true,"yield_time_ms":100,"permission_request":{"reason":"write the chosen result", "writable_paths":[grant_link]}})).await;
    assert!(!first.is_error, "{first:?}");
    let first = ready(&tools, &session, first.output, |text| text == "ready").await;
    assert_eq!(first["output"], "ready");
    let done = call(&tools, &session, json!({"action":"interact", "session_id":first["session_id"], "input":"approved content\n"})).await;
    assert!(!done.is_error, "{done:?}");
    assert_eq!(done.output["exit_code"], 0, "{done:?}");
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("approved")).unwrap(),
        "approved content"
    );
    let next = call(
        &tools,
        &session,
        json!({"action":"exec","cmd":"touch unapproved"}),
    )
    .await;
    assert_ne!(next.output["exit_code"], 0);
    assert!(!workspace.path().join("unapproved").exists());
    let requests = approver.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].command, command);
    assert_eq!(
        requests[0].workdir,
        workspace.path().canonicalize().unwrap()
    );
    assert!(requests[0].tty);
    assert_eq!(
        requests[0].permissions.writable_paths,
        vec![workspace.path().canonicalize().unwrap()],
        "宿主必须看到真实授权目标，不能只显示符号链接名称"
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn unsafe_or_forged_permission_requests_are_rejected_before_host_approval() {
    let workspace = tempfile::tempdir().unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowOnce));
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::with_shell(workspace.path(), "/bin/sh")
                .unwrap()
                .with_approver(approver.clone()),
        )
        .unwrap();
    let session = AgentSession::new();
    for permissions in [
        json!({"reason":"write everything","writable_paths":["/"]}),
        json!({"reason":"relative grant","readable_paths":["../private"]}),
        json!({"reason":"model approved","network":true,"approved":true}),
        json!({"reason":" ","network":true}),
        json!({"reason":"no permissions"}),
    ] {
        let rejected = call(
            &tools,
            &session,
            json!({"action":"exec","cmd":"touch dispatched","permission_request":permissions}),
        )
        .await;
        assert!(rejected.is_error, "{rejected:?}");
    }
    assert!(approver.requests.lock().unwrap().is_empty());
    assert!(!workspace.path().join("dispatched").exists());
    session.close().await.unwrap();
}

#[tokio::test]
async fn cancelling_pending_approval_does_not_start_a_process_or_execute_late() {
    let workspace = tempfile::tempdir().unwrap();
    let approver = Approver::new(None);
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::with_shell(workspace.path(), "/bin/sh")
                .unwrap()
                .with_approver(approver.clone()),
        )
        .unwrap();
    let session = AgentSession::new();
    let cancellation = CancellationToken::new();
    let context = ExecutionContext::new(cancellation.clone(), Duration::from_secs(5)).unwrap();
    let request = ToolCall {
        id: "approval".into(),
        name: "terminal".into(),
        arguments: json!({"action":"exec","cmd":"touch late","permission_request":{"reason":"network required","network":true}}),
    };
    let operation = tools.execute_in_session(&request, context, &session);
    tokio::pin!(operation);
    tokio::select! { _ = approver.entered.notified() => {}, result = &mut operation => panic!("审批尚未决定：{result:?}") }
    cancellation.cancel();
    assert!(matches!(
        operation.await,
        Err(noemori_agent::Error::Cancelled)
    ));
    assert!(!workspace.path().join("late").exists());
    assert_eq!(
        call(&tools, &session, json!({"action":"list"}))
            .await
            .output,
        json!({"terminals":[]})
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn session_permission_approval_is_reused_only_inside_the_same_conversation() {
    let decision: TerminalApprovalDecision =
        serde_json::from_value(json!({"decision":"allow_for_session"}))
            .expect("宿主审批须支持会话授权");
    let workspace = tempfile::tempdir().unwrap();
    let approver = Approver::new(Some(decision));
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::with_shell(workspace.path(), "/bin/sh")
                .unwrap()
                .with_approver(approver.clone()),
        )
        .unwrap();
    let session = AgentSession::new();
    for command in ["printf first", "printf second"] {
        let result = call(&tools, &session, json!({"action":"exec", "cmd":command, "permission_request":{"reason":"network needed", "network":true}})).await;
        assert!(!result.is_error, "{result:?}");
    }
    assert_eq!(approver.requests.lock().unwrap().len(), 1);
    session.close().await.unwrap();
    let other = AgentSession::new();
    call(&tools, &other, json!({"action":"exec", "cmd":"printf third", "permission_request":{"reason":"network needed", "network":true}})).await;
    assert_eq!(approver.requests.lock().unwrap().len(), 2);
    other.close().await.unwrap();
}
