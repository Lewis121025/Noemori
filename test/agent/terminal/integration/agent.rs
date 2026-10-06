#![cfg(unix)]

#[path = "../../support/model.rs"]
mod support;

use noemori_agent::{
    AgentSession, ContentPart, Message, Role,
    runtime::{Agent, RunInput, RunOptions, RunStatus},
    tool::{
        ToolRegistry,
        terminal::{SandboxMode, TerminalTool},
    },
};
use serde_json::json;
use std::sync::Arc;
use support::{ScriptedModel, answer, calls};

#[tokio::test]
async fn terminal_errors_reach_model_and_one_agent_can_reuse_a_session_across_runs() {
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&[(
            "start",
            "terminal",
            json!({"action":"exec","cmd":"sleep 30","yield_time_ms":0}),
        )])],
        vec![answer("已启动")],
        vec![calls(&[
            ("list", "terminal", json!({"action":"list"})),
            (
                "bad",
                "terminal",
                json!({"action":"interact","session_id":"unknown"}),
            ),
        ])],
        vec![answer("已看到进程与错误原因")],
    ]));
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::configured(std::env::temp_dir(), "/bin/sh", SandboxMode::Disabled)
                .unwrap(),
        )
        .unwrap();
    let agent = Agent::new(model.clone(), tools, RunOptions::default()).unwrap();
    let session = AgentSession::new();
    for _ in 0..2 {
        let mut input = RunInput::new(vec![Message::text(Role::User, "执行")]);
        input.session = session.clone();
        let report = agent.run(input).await.unwrap();
        assert!(matches!(report.status, RunStatus::Completed));
    }
    {
        let requests = model.requests.lock().unwrap();
        let results = &requests[3].messages.last().unwrap().content;
        assert!(
            matches!(&results[0], ContentPart::ToolResult(r) if r.output["terminals"].as_array().unwrap().len() == 1)
        );
        assert!(
            matches!(&results[1], ContentPart::ToolResult(r) if r.is_error && r.output["error"].as_str().unwrap().contains("不存在"))
        );
    }
    session.close().await.unwrap();
}

#[tokio::test]
async fn agent_timeout_preserves_session_process_for_the_next_run() {
    use noemori_agent::{CancellationToken, ExecutionContext, ToolCall};
    use std::time::Duration;
    let model = Arc::new(ScriptedModel::new(vec![vec![calls(&[(
        "start",
        "terminal",
        json!({"action":"exec","cmd":"sleep 30","yield_time_ms":30000}),
    )])]]));
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::configured(std::env::temp_dir(), "/bin/sh", SandboxMode::Disabled)
                .unwrap(),
        )
        .unwrap();
    let agent = Agent::new(
        model,
        tools.clone(),
        RunOptions {
            timeout: Duration::from_millis(150),
            ..RunOptions::default()
        },
    )
    .unwrap();
    let session = AgentSession::new();
    let mut input = RunInput::new(vec![Message::text(Role::User, "启动")]);
    input.session = session.clone();
    let report = agent.run(input).await.unwrap();
    assert!(matches!(report.status, RunStatus::TimedOut));
    let result = tools
        .execute_in_session(
            &ToolCall {
                id: "list".into(),
                name: "terminal".into(),
                arguments: json!({"action":"list"}),
            },
            ExecutionContext::new(CancellationToken::new(), Duration::from_secs(3)).unwrap(),
            &session,
        )
        .await
        .unwrap();
    assert_eq!(result.output["terminals"][0]["status"], "running");
    session.close().await.unwrap();
}

struct PendingModel;
impl noemori_agent::llm::Model for PendingModel {
    fn capabilities(&self) -> noemori_agent::llm::Capabilities {
        noemori_agent::llm::Capabilities::default()
    }
    fn generate(
        &self,
        _: noemori_agent::llm::ModelRequest,
        _: noemori_agent::ExecutionContext,
    ) -> noemori_agent::llm::ModelStream {
        Box::pin(futures::stream::pending())
    }
}

#[tokio::test]
async fn closing_session_cancels_active_model_and_rejects_future_runs() {
    use futures::StreamExt;
    let agent = Agent::new(
        Arc::new(PendingModel),
        ToolRegistry::new(),
        RunOptions::default(),
    )
    .unwrap();
    let session = AgentSession::new();
    let mut input = RunInput::new(vec![Message::text(Role::User, "等待")]);
    input.session = session.clone();
    let parent = input.cancellation.clone();
    let mut stream = agent.stream(input.clone()).unwrap();
    assert!(matches!(
        stream.next().await,
        Some(noemori_agent::runtime::AgentEvent::ModelStarted { .. })
    ));
    tokio::select! { _ = stream.next() => panic!("模型应持续等待"), _ = tokio::task::yield_now() => {} }
    session.close().await.unwrap();
    assert!(
        matches!(stream.next().await, Some(noemori_agent::runtime::AgentEvent::Finished(report)) if matches!(report.status, RunStatus::Cancelled))
    );
    assert!(!parent.is_cancelled());
    assert!(agent.stream(input).is_err());
}
