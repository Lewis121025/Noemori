use super::{Approver, call};
use noemori_agent::{
    AgentSession,
    tool::{
        ToolRegistry,
        terminal::{
            SandboxConfig, SandboxEnvironment, SandboxMode, TerminalApprovalDecision,
            TerminalApprovalStore, TerminalTool,
        },
    },
};
use serde_json::json;
use std::{path::Path, sync::Arc};

fn registry(
    workspace: &Path,
    approver: Option<Arc<Approver>>,
    store: Option<Arc<TerminalApprovalStore>>,
) -> ToolRegistry {
    let mut tool = TerminalTool::with_shell(workspace, "/bin/sh").unwrap();
    if let Some(approver) = approver {
        tool = tool.with_approver(approver);
    }
    if let Some(store) = store {
        tool = tool.with_approval_store(store).unwrap();
    }
    let mut registry = ToolRegistry::new();
    registry.register(tool).unwrap();
    registry
}

#[tokio::test]
async fn session_prefix_rules_require_literal_commands_and_keep_the_original_execution_scope() {
    let workspace = tempfile::tempdir().unwrap();
    let nested = workspace.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowPrefix {
        prefix: vec!["printf".into()],
    }));
    let tools = registry(workspace.path(), Some(approver.clone()), None);
    let session = AgentSession::new();
    for command in [
        "printf first",
        "printf second",
        "printf '%s' '$(touch unexpected)'",
    ] {
        let result = call(&tools, &session, json!({"action":"exec", "cmd":command, "permission_request":{"reason":"network needed", "network":true}})).await;
        assert!(!result.is_error, "{result:?}");
    }
    assert_eq!(approver.requests.lock().unwrap().len(), 1);
    assert!(!workspace.path().join("unexpected").exists());
    for command in [
        "printf first; touch unexpected",
        "printf first && touch unexpected",
        "printf '%s' \"$(touch unexpected)\"",
    ] {
        let result = call(&tools, &session, json!({"action":"exec", "cmd":command, "permission_request":{"reason":"network needed", "network":true}})).await;
        assert!(
            result.is_error,
            "复杂调用不能通过原前缀规则自动授权：{result:?}"
        );
    }
    assert_eq!(approver.requests.lock().unwrap().len(), 4);
    assert!(!workspace.path().join("unexpected").exists());
    let changed = call(&tools, &session, json!({"action":"exec", "cmd":"printf new-directory", "workdir":nested, "permission_request":{"reason":"network needed", "network":true}})).await;
    assert!(!changed.is_error);
    assert_eq!(
        approver.requests.lock().unwrap().len(),
        5,
        "切换工作目录必须重新审批"
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn session_grants_can_narrow_resources_but_cannot_upgrade_reading_to_writing_or_add_network()
{
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let child = outside.path().join("child");
    std::fs::create_dir(&child).unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowForSession));
    let tools = registry(workspace.path(), Some(approver.clone()), None);
    let session = AgentSession::new();
    for permissions in [
        json!({"reason":"read directory", "readable_paths":[outside.path()]}),
        json!({"reason":"read smaller directory", "readable_paths":[child]}),
    ] {
        assert!(
            !call(
                &tools,
                &session,
                json!({"action":"exec", "cmd":"printf allowed", "permission_request":permissions})
            )
            .await
            .is_error
        );
    }
    assert_eq!(approver.requests.lock().unwrap().len(), 1);
    assert!(!call(&tools, &session, json!({"action":"exec", "cmd":"printf write-authorized", "permission_request":{"reason":"write directory", "writable_paths":[outside.path()]}})).await.is_error);
    assert_eq!(approver.requests.lock().unwrap().len(), 2);
    assert!(!call(&tools, &session, json!({"action":"exec", "cmd":"printf network-authorized", "permission_request":{"reason":"network", "network":true}})).await.is_error);
    assert_eq!(approver.requests.lock().unwrap().len(), 3);
    session.close().await.unwrap();
}

#[tokio::test]
async fn persistent_prefix_rules_survive_reopening_and_revocation_takes_effect_without_restarting()
{
    use std::os::unix::fs::PermissionsExt;
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("rules.json");
    let store = Arc::new(TerminalApprovalStore::open(&path).unwrap());
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowPersistentPrefix {
        prefix: vec!["printf".into()],
    }));
    let tools = registry(
        workspace.path(),
        Some(approver.clone()),
        Some(store.clone()),
    );
    let session = AgentSession::new();
    let result = call(&tools, &session, json!({"action":"exec", "cmd":"printf saved", "permission_request":{"reason":"network needed", "network":true}})).await;
    assert!(!result.is_error, "{result:?}");
    assert_eq!(result.output["output"], "saved");
    assert_eq!(store.rules().len(), 1);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
        0
    );
    let rule = store.rules()[0].id.clone();
    session.close().await.unwrap();
    drop(tools);
    drop(store);
    let reopened = Arc::new(TerminalApprovalStore::open(&path).unwrap());
    let tools = registry(workspace.path(), None, Some(reopened.clone()));
    let session = AgentSession::new();
    let reused = call(&tools, &session, json!({"action":"exec", "cmd":"printf reused", "permission_request":{"reason":"network needed", "network":true}})).await;
    assert!(!reused.is_error, "已保存的规则无需新审批处理器：{reused:?}");
    assert_eq!(reused.output["output"], "reused");
    assert!(!reopened.revoke("missing-rule").unwrap());
    assert!(reopened.revoke(&rule).unwrap());
    let denied = call(&tools, &session, json!({"action":"exec", "cmd":"printf should-not-run", "permission_request":{"reason":"network needed", "network":true}})).await;
    assert!(denied.is_error);
    assert!(reopened.rules().is_empty());
    session.close().await.unwrap();
}

#[tokio::test]
async fn approval_store_and_its_ancestors_cannot_become_command_writable_paths() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let inside =
        Arc::new(TerminalApprovalStore::open(workspace.path().join("rules.json")).unwrap());
    assert!(
        TerminalTool::with_shell(workspace.path(), "/bin/sh")
            .unwrap()
            .with_approval_store(inside)
            .is_err()
    );
    let store = Arc::new(TerminalApprovalStore::open(data.path().join("rules.json")).unwrap());
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowForSession));
    let tools = registry(workspace.path(), Some(approver.clone()), Some(store));
    let session = AgentSession::new();
    let rejected = call(&tools, &session, json!({"action":"exec", "cmd":"touch dispatched", "permission_request":{"reason":"write application data", "writable_paths":[data.path()]}})).await;
    assert!(rejected.is_error);
    assert!(
        approver.requests.lock().unwrap().is_empty(),
        "不允许审批模型的自授权路径"
    );
    assert!(!workspace.path().join("dispatched").exists());
    session.close().await.unwrap();
}

#[tokio::test]
async fn persistent_write_failures_do_not_execute_commands_or_publish_an_uncommitted_rule() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("rules.json");
    let store = Arc::new(TerminalApprovalStore::open(&path).unwrap());
    std::fs::create_dir(&path).unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowPersistentPrefix {
        prefix: vec!["touch".into()],
    }));
    let tools = registry(workspace.path(), Some(approver), Some(store.clone()));
    let session = AgentSession::new();
    let rejected = call(&tools, &session, json!({"action":"exec", "cmd":"touch dispatched", "permission_request":{"reason":"network needed", "network":true}})).await;
    assert!(rejected.is_error);
    assert!(store.rules().is_empty());
    assert!(!workspace.path().join("dispatched").exists());
    session.close().await.unwrap();
}

#[tokio::test]
async fn changed_host_environment_and_longer_command_lifetimes_require_new_approval() {
    let workspace = tempfile::tempdir().unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowPrefix {
        prefix: vec!["printf".into()],
    }));
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::with_shell(workspace.path(), "/bin/sh")
                .unwrap()
                .with_approver(approver.clone()),
        )
        .unwrap();
    let session = AgentSession::new();
    for timeout in [10000, 5000, 20000] {
        assert!(!call(&tools, &session, json!({"action":"exec", "cmd":"printf allowed", "timeout_ms":timeout, "permission_request":{"reason":"network needed", "network":true}})).await.is_error);
    }
    assert_eq!(approver.requests.lock().unwrap().len(), 2);
    let changed = TerminalTool::configured(
        workspace.path(),
        "/bin/sh",
        SandboxMode::Restricted(SandboxConfig {
            environment: SandboxEnvironment {
                variables: std::collections::BTreeMap::from([("PROFILE".into(), "changed".into())]),
                ..Default::default()
            },
            ..Default::default()
        }),
    )
    .unwrap()
    .with_approver(approver.clone());
    let mut other = ToolRegistry::new();
    other.register(changed).unwrap();
    assert!(!call(&other, &session, json!({"action":"exec", "cmd":"printf allowed", "timeout_ms":10000, "permission_request":{"reason":"network needed", "network":true}})).await.is_error);
    assert_eq!(approver.requests.lock().unwrap().len(), 3);
    session.close().await.unwrap();
}

#[tokio::test]
async fn a_previously_approved_file_cannot_silently_become_a_recursive_directory_grant() {
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("target");
    std::fs::write(&target, "first").unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowForSession));
    let tools = registry(workspace.path(), Some(approver.clone()), None);
    let session = AgentSession::new();
    assert!(!call(&tools, &session, json!({"action":"exec", "cmd":"printf first", "permission_request":{"reason":"read a file", "readable_paths":[target]}})).await.is_error);
    std::fs::remove_file(&target).unwrap();
    std::fs::create_dir(&target).unwrap();
    assert!(!call(&tools, &session, json!({"action":"exec", "cmd":"printf second", "permission_request":{"reason":"read a directory", "readable_paths":[target]}})).await.is_error);
    assert_eq!(approver.requests.lock().unwrap().len(), 2);
    session.close().await.unwrap();
}

#[tokio::test]
async fn unrelated_host_prefixes_and_persistence_without_a_store_are_rejected_before_execution() {
    let workspace = tempfile::tempdir().unwrap();
    for decision in [
        TerminalApprovalDecision::AllowPrefix { prefix: vec![] },
        TerminalApprovalDecision::AllowPrefix {
            prefix: vec!["git".into()],
        },
        TerminalApprovalDecision::AllowPersistentPrefix {
            prefix: vec!["touch".into()],
        },
    ] {
        let tools = registry(workspace.path(), Some(Approver::new(Some(decision))), None);
        let session = AgentSession::new();
        let rejected = call(&tools, &session, json!({"action":"exec", "cmd":"touch dispatched", "permission_request":{"reason":"network needed", "network":true}})).await;
        assert!(rejected.is_error);
        assert!(!workspace.path().join("dispatched").exists());
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn concurrent_calls_share_one_session_approval_and_closed_sessions_cannot_reuse_it() {
    let workspace = tempfile::tempdir().unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowForSession));
    let tools = registry(workspace.path(), Some(approver.clone()), None);
    let session = AgentSession::new();
    let arguments = json!({"action":"exec", "cmd":"printf allowed", "permission_request":{"reason":"network needed", "network":true}});
    let (first, second) = tokio::join!(
        call(&tools, &session, arguments.clone()),
        call(&tools, &session, arguments.clone())
    );
    assert!(!first.is_error && !second.is_error);
    assert_eq!(approver.requests.lock().unwrap().len(), 1);
    session.close().await.unwrap();
    let closed = tools
        .execute_in_session(
            &noemori_agent::ToolCall {
                id: "closed".into(),
                name: "terminal".into(),
                arguments,
            },
            noemori_agent::ExecutionContext::new(
                noemori_agent::CancellationToken::new(),
                std::time::Duration::from_secs(5),
            )
            .unwrap(),
            &session,
        )
        .await;
    assert!(closed.is_err());
    assert_eq!(approver.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn persistent_rules_match_equivalent_snapshots_and_require_approval_after_environment_changes()
 {
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("rules.json");
    let profile = home.path().join(".bash_profile");
    std::fs::write(
        &profile,
        "export SNAPSHOT_VALUE=original\nfixture() { printf '%s' \"$SNAPSHOT_VALUE\"; }\n",
    )
    .unwrap();
    let approver = Approver::new(Some(TerminalApprovalDecision::AllowPersistentPrefix {
        prefix: vec!["fixture".into()],
    }));
    let store = Arc::new(TerminalApprovalStore::open(&path).unwrap());
    let base = TerminalTool::configured(
        workspace.path(),
        "/bin/bash",
        SandboxMode::Restricted(SandboxConfig {
            readable_paths: vec![home.path().to_owned()],
            ..Default::default()
        }),
    )
    .unwrap()
    .with_approver(approver.clone())
    .with_approval_store(store.clone())
    .unwrap();
    let capture = || {
        noemori_agent::ExecutionContext::new(
            noemori_agent::CancellationToken::new(),
            std::time::Duration::from_secs(10),
        )
        .unwrap()
    };
    let first = base
        .clone()
        .capture_shell_snapshot(home.path(), capture())
        .await
        .unwrap();
    let mut first_registry = ToolRegistry::new();
    first_registry.register(first).unwrap();
    let session = AgentSession::new();
    let arguments = json!({"action":"exec", "cmd":"fixture", "permission_request":{"reason":"network needed", "network":true}});
    let result = call(&first_registry, &session, arguments.clone()).await;
    assert!(!result.is_error, "{result:?}");
    assert_eq!(result.output["output"], "original");
    let equivalent = base
        .clone()
        .capture_shell_snapshot(home.path(), capture())
        .await
        .unwrap();
    let mut second_registry = ToolRegistry::new();
    second_registry.register(equivalent).unwrap();
    assert!(
        !call(&second_registry, &session, arguments.clone())
            .await
            .is_error
    );
    assert_eq!(
        approver.requests.lock().unwrap().len(),
        1,
        "随机快照身份不应导致相同初始化内容的持久规则失效"
    );
    std::fs::write(
        &profile,
        "export SNAPSHOT_VALUE=changed\nfixture() { printf '%s' \"$SNAPSHOT_VALUE\"; }\n",
    )
    .unwrap();
    let changed = base
        .capture_shell_snapshot(home.path(), capture())
        .await
        .unwrap();
    let mut changed_registry = ToolRegistry::new();
    changed_registry.register(changed).unwrap();
    let result = call(&changed_registry, &session, arguments).await;
    assert!(!result.is_error);
    assert_eq!(result.output["output"], "changed");
    assert_eq!(approver.requests.lock().unwrap().len(), 2);
    assert_eq!(store.rules().len(), 2);
    session.close().await.unwrap();
}
