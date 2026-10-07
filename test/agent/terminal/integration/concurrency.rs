use super::{ScriptedModel, answer, calls};
use futures::StreamExt;
use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, Message, Role, ToolCall,
    runtime::{Agent, AgentEvent, RunInput, RunOptions, RunStatus},
    tool::{
        Tool, ToolConcurrency, ToolRegistry,
        terminal::{
            NetworkAccess, SandboxConfig, SandboxMode, TerminalInput, TerminalTool, WorkspaceAccess,
        },
    },
};
use serde_json::json;
use std::{sync::Arc, time::Duration};

#[tokio::test]
async fn readonly_agent_dispatches_real_processes_concurrently() {
    let workspace = tempfile::tempdir().unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::configured(
                workspace.path(),
                "/bin/sh",
                SandboxMode::Restricted(SandboxConfig {
                    workspace_access: WorkspaceAccess::ReadOnly,
                    ..Default::default()
                }),
            )
            .unwrap(),
        )
        .unwrap();
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&[
            (
                "fast",
                "terminal",
                json!({"action":"exec", "cmd":"printf fast", "yield_time_ms":1000}),
            ),
            (
                "slow",
                "terminal",
                json!({"action":"exec", "cmd":"sleep 30", "yield_time_ms":1000}),
            ),
        ])],
        vec![answer("done")],
    ]));
    let agent = Agent::new(model, tools.clone(), RunOptions::default()).unwrap();
    let session = AgentSession::new();
    let mut input = RunInput::new(vec![Message::text(Role::User, "读取")]);
    input.session = session.clone();
    let mut stream = agent.stream(input).unwrap();
    let mut starts = Vec::new();
    while let Some(event) = stream.next().await {
        match event {
            AgentEvent::ToolStarted(call) => starts.push(call.id),
            AgentEvent::ToolFinished(result) => {
                assert_eq!(result.call_id, "fast");
                assert_eq!(starts, ["fast", "slow"]);
                let list = tools
                    .execute_in_session(
                        &ToolCall {
                            id: "list".into(),
                            name: "terminal".into(),
                            arguments: json!({"action":"list"}),
                        },
                        ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5))
                            .unwrap(),
                        &session,
                    )
                    .await
                    .unwrap();
                let terminals = list.output["terminals"].as_array().unwrap();
                assert_eq!(terminals.len(), 2);
                assert!(
                    terminals
                        .iter()
                        .any(|terminal| terminal["status"] == "running")
                );
                break;
            }
            _ => {}
        }
    }
    while let Some(event) = stream.next().await {
        if let AgentEvent::Finished(report) = event {
            assert!(matches!(report.status, RunStatus::Completed));
        }
    }
    session.close().await.unwrap();
}

#[test]
fn only_kernel_enforced_readonly_offline_execution_is_marked_concurrent() {
    let workspace = tempfile::tempdir().unwrap();
    let exec: TerminalInput =
        serde_json::from_value(json!({"action":"exec","cmd":"arbitrary shell"})).unwrap();
    for (mode, expected) in [
        (SandboxMode::Disabled, ToolConcurrency::Sequential),
        (SandboxMode::default(), ToolConcurrency::Sequential),
        (
            SandboxMode::Restricted(SandboxConfig {
                workspace_access: WorkspaceAccess::ReadOnly,
                ..Default::default()
            }),
            ToolConcurrency::Concurrent,
        ),
        (
            SandboxMode::Restricted(SandboxConfig {
                workspace_access: WorkspaceAccess::ReadOnly,
                network: NetworkAccess::Allowed,
                ..Default::default()
            }),
            ToolConcurrency::Sequential,
        ),
    ] {
        let tool = TerminalTool::configured(workspace.path(), "/bin/sh", mode).unwrap();
        assert_eq!(tool.concurrency(&exec), expected);
        for arguments in [
            json!({"action":"list"}),
            json!({"action":"stop","session_id":"owned"}),
            json!({"action":"exec","cmd":"arbitrary shell","permission_request":{"reason":"extra rights","network":true}}),
        ] {
            assert_eq!(
                tool.concurrency(&serde_json::from_value(arguments).unwrap()),
                ToolConcurrency::Sequential
            );
        }
    }
}
