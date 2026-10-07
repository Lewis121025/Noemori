use super::*;
use noemori_agent::tool::terminal::{
    TerminalCommandDecision, TerminalCommandPattern, TerminalCommandPolicy, TerminalCommandRule,
};

fn policy(prefix: &[&str], decision: TerminalCommandDecision) -> TerminalCommandPolicy {
    TerminalCommandPolicy::new(vec![TerminalCommandRule {
        pattern: prefix
            .iter()
            .map(|word| TerminalCommandPattern::Word((*word).into()))
            .collect(),
        decision,
        justification: Some("host command policy".into()),
        matches: Vec::new(),
        not_matches: Vec::new(),
    }])
    .unwrap()
}

fn registry(
    workspace: &std::path::Path,
    policy: TerminalCommandPolicy,
    approver: Option<Arc<Approver>>,
) -> ToolRegistry {
    let mut tool = TerminalTool::with_shell(workspace, "/bin/sh")
        .unwrap()
        .with_command_policy(policy);
    if let Some(approver) = approver {
        tool = tool.with_approver(approver);
    }
    let mut tools = ToolRegistry::new();
    tools.register(tool).unwrap();
    tools
}

#[tokio::test]
async fn forbidden_commands_are_checked_before_resources_or_host_approval_and_block_safe_shell_wrappers()
 {
    let workspace = tempfile::tempdir().unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowForSession));
    let tools = registry(
        workspace.path(),
        policy(&["touch"], TerminalCommandDecision::Forbidden),
        Some(approver.clone()),
    );
    let session = AgentSession::new();
    for command in [
        "touch dispatched",
        "printf allowed && touch dispatched",
        "sh -c 'printf allowed; touch dispatched'",
    ] {
        let denied = call(&tools, &session, json!({"action":"exec", "cmd":command, "permission_request":{"reason":"network needed", "network":true}})).await;
        assert!(denied.is_error, "{command}: {denied:?}");
        assert!(
            denied.output["error"]
                .as_str()
                .unwrap()
                .contains("host command policy")
        );
    }
    assert!(!workspace.path().join("dispatched").exists());
    assert!(approver.requests.lock().unwrap().is_empty());
    session.close().await.unwrap();
}

#[tokio::test]
async fn command_prompt_rules_require_fresh_approval_even_when_resource_consent_was_saved() {
    let workspace = tempfile::tempdir().unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowForSession));
    let tools = registry(
        workspace.path(),
        policy(&["printf"], TerminalCommandDecision::Prompt),
        Some(approver.clone()),
    );
    let session = AgentSession::new();
    for value in ["first", "second"] {
        let result = call(&tools, &session, json!({"action":"exec", "cmd":format!("printf {value}"), "permission_request":{"reason":"network needed", "network":true}})).await;
        assert!(!result.is_error, "{result:?}");
        assert_eq!(result.output["output"], value);
    }
    assert_eq!(approver.requests.lock().unwrap().len(), 2);
    session.close().await.unwrap();
}

#[tokio::test]
async fn command_only_approval_does_not_implicitly_expand_the_sandbox() {
    let workspace = tempfile::tempdir().unwrap();
    let tools = registry(
        workspace.path(),
        policy(&["printf"], TerminalCommandDecision::Prompt),
        None,
    );
    let session = AgentSession::new();
    assert!(
        call(
            &tools,
            &session,
            json!({"action":"exec", "cmd":"printf hidden"})
        )
        .await
        .is_error
    );
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowOnce));
    let tools = registry(
        workspace.path(),
        policy(&["printf"], TerminalCommandDecision::Prompt),
        Some(approver.clone()),
    );
    let allowed = call(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"printf visible"}),
    )
    .await;
    assert!(!allowed.is_error, "{allowed:?}");
    assert_eq!(allowed.output["output"], "visible");
    let requests = approver.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].permissions.readable_paths.is_empty());
    assert!(requests[0].permissions.writable_paths.is_empty());
    assert!(!requests[0].permissions.network);
    assert_eq!(
        requests[0].command_policy.as_ref().unwrap().decision,
        Some(TerminalCommandDecision::Prompt)
    );
    let private = tempfile::tempdir().unwrap();
    let secret = private.path().join("secret");
    std::fs::write(&secret, "must stay private").unwrap();
    let denied_read = call(
        &tools,
        &session,
        json!({"action":"exec", "cmd":format!("printf allowed; cat '{}'", secret.display())}),
    )
    .await;
    assert!(!denied_read.is_error, "{denied_read:?}");
    assert_ne!(denied_read.output["exit_code"], 0);
    assert!(
        !denied_read.output["output"]
            .as_str()
            .unwrap()
            .contains("must stay private")
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn installing_a_forbidden_rule_blocks_permission_reuse_from_an_already_approved_session() {
    let workspace = tempfile::tempdir().unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowForSession));
    let base = TerminalTool::with_shell(workspace.path(), "/bin/sh")
        .unwrap()
        .with_approver(approver.clone());
    let mut before = ToolRegistry::new();
    before.register(base.clone()).unwrap();
    let session = AgentSession::new();
    let arguments = json!({"action":"exec", "cmd":"printf allowed", "permission_request":{"reason":"network needed", "network":true}});
    assert!(!call(&before, &session, arguments.clone()).await.is_error);
    let mut after = ToolRegistry::new();
    after
        .register(base.with_command_policy(policy(&["printf"], TerminalCommandDecision::Forbidden)))
        .unwrap();
    assert!(call(&after, &session, arguments).await.is_error);
    assert_eq!(approver.requests.lock().unwrap().len(), 1);
    session.close().await.unwrap();
}

#[tokio::test]
async fn allowing_a_command_never_implicitly_approves_requested_resources() {
    let workspace = tempfile::tempdir().unwrap();
    let tools = registry(
        workspace.path(),
        policy(&["printf"], TerminalCommandDecision::Allow),
        None,
    );
    let session = AgentSession::new();
    let allowed = call(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"printf visible"}),
    )
    .await;
    assert!(!allowed.is_error);
    let extra = call(&tools, &session, json!({"action":"exec", "cmd":"printf hidden", "permission_request":{"reason":"network needed", "network":true}})).await;
    assert!(extra.is_error, "{extra:?}");
    session.close().await.unwrap();
}
