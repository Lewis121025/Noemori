mod browser_history;
mod concurrency;
mod media;
#[path = "../../support/model.rs"]
mod support;

use async_trait::async_trait;
use futures::StreamExt;
use noemori_agent::llm::{
    Capabilities, FinishReason, Model, ModelEvent, ModelRequest, ModelStream,
};
use noemori_agent::runtime::{Agent, AgentEvent, RunInput, RunOptions, RunStatus};
use noemori_agent::tool::{Tool, ToolContext, ToolError, ToolRegistry};
use noemori_agent::{CancellationToken, Error, ExecutionContext, Message, Role, validate_history};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::{ScriptedModel, answer, calls};

#[derive(Deserialize, JsonSchema)]
struct Args {
    value: u32,
}
struct Double(Arc<AtomicUsize>);
#[async_trait]
impl Tool for Double {
    type Args = Args;
    type Output = u32;
    fn name(&self) -> &str {
        "double"
    }
    fn description(&self) -> &str {
        "测试工具"
    }
    async fn execute(&self, args: Args, _: ToolContext) -> Result<u32, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(args.value * 2)
    }
}
fn input() -> RunInput {
    RunInput::new(vec![Message::text(Role::User, "计算")])
}
fn agent(model: Arc<dyn Model>, tools: ToolRegistry, max_calls: usize) -> Agent {
    Agent::new(
        model,
        tools,
        RunOptions {
            max_model_calls: max_calls,
            retry_delay: Duration::ZERO,
            ..RunOptions::default()
        },
    )
    .unwrap()
}

#[tokio::test]
async fn empty_slots_finish_in_one_call_and_runs_do_not_share_history() {
    let model = Arc::new(ScriptedModel::new(vec![
        vec![answer("一")],
        vec![answer("二")],
    ]));
    let agent = agent(model.clone(), ToolRegistry::new(), 8);
    for text in ["一", "二"] {
        let report = agent.run(input()).await.unwrap();
        assert!(matches!(report.status, RunStatus::Completed));
        assert_eq!(report.model_calls, 1);
        assert!(report.pending_turn.is_none());
        assert_eq!(report.history.last().unwrap().text_content(), text);
    }
    assert!(
        model
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.messages.len() == 1 && r.tools.is_empty())
    );
}

#[tokio::test]
async fn tools_round_trip_in_order_and_commit_before_next_model_call() {
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&[
            ("a", "double", json!({"value":2})),
            ("b", "double", json!({"value":3})),
        ])],
        vec![answer("4 和 6")],
    ]));
    let count = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Double(count.clone())).unwrap();
    let report = agent(model.clone(), tools, 3).run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(count.load(Ordering::SeqCst), 2);
    validate_history(&report.history).unwrap();
    let requests = model.requests.lock().unwrap();
    let results = &requests[1].messages.last().unwrap().content;
    assert!(
        matches!(&results[0],noemori_agent::ContentPart::ToolResult(r)if r.call_id=="a"&&r.output==json!(4))
    );
    assert!(
        matches!(&results[1],noemori_agent::ContentPart::ToolResult(r)if r.call_id=="b"&&r.output==json!(6))
    );
}

#[tokio::test]
async fn invalid_arguments_and_unknown_tools_become_observations() {
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&[
            ("a", "double", json!({"value":"bad"})),
            ("b", "unknown", json!({})),
        ])],
        vec![answer("已纠正")],
    ]));
    let count = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Double(count.clone())).unwrap();
    let report = agent(model, tools, 3).run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(
        report.history[2]
            .content
            .iter()
            .all(|p| matches!(p,noemori_agent::ContentPart::ToolResult(r)if r.is_error))
    );
}

#[tokio::test]
async fn call_budget_includes_initial_attempt_and_retries() {
    let model = Arc::new(ScriptedModel::new(vec![
        vec![Err(Error::Http {
            status: 429,
            message: "limit".into(),
            retry_after: Some(Duration::ZERO),
        })],
        vec![answer("成功")],
    ]));
    let report = agent(model, ToolRegistry::new(), 2)
        .run(input())
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(report.model_calls, 2);
    let model = Arc::new(ScriptedModel::new(vec![]));
    let report = agent(model.clone(), ToolRegistry::new(), 0)
        .run(input())
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::BudgetExhausted));
    assert!(model.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn partial_output_is_not_retried_or_committed() {
    let model = Arc::new(ScriptedModel::new(vec![vec![
        Ok(ModelEvent::TextDelta("部分".into())),
        Err(Error::Http {
            status: 503,
            message: "断开".into(),
            retry_after: None,
        }),
    ]]));
    let report = agent(model, ToolRegistry::new(), 8)
        .run(input())
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::Failed(_)));
    assert_eq!(report.model_calls, 1);
    assert_eq!(report.history.len(), 1);
    assert_eq!(report.pending_turn.unwrap().deltas.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn retry_wait_respects_the_run_deadline_without_an_extra_request() {
    let model = Arc::new(ScriptedModel::new(vec![vec![Err(Error::Http {
        status: 429,
        message: "limit".into(),
        retry_after: Some(Duration::from_secs(10)),
    })]]));
    let agent = Agent::new(
        model.clone(),
        ToolRegistry::new(),
        RunOptions {
            timeout: Duration::from_secs(1),
            ..Default::default()
        },
    )
    .unwrap();
    let report = agent.run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::TimedOut));
    assert_eq!(report.model_calls, 1);
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn cancellation_during_retry_wait_stops_further_requests() {
    let model = Arc::new(ScriptedModel::new(vec![vec![Err(Error::Http {
        status: 503,
        message: "retry".into(),
        retry_after: Some(Duration::from_secs(10)),
    })]]));
    let input = input();
    let cancellation = input.cancellation.clone();
    let mut stream = agent(model.clone(), ToolRegistry::new(), 8)
        .stream(input)
        .unwrap();
    let report = loop {
        match stream.next().await.unwrap() {
            AgentEvent::RetryScheduled { .. } => cancellation.cancel(),
            AgentEvent::Finished(report) => break report,
            _ => {}
        }
    };
    assert!(matches!(report.status, RunStatus::Cancelled));
    assert_eq!(report.model_calls, 1);
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn retry_exhaustion_is_bounded_and_preserves_the_original_request() {
    let model = Arc::new(ScriptedModel::new(
        (0..3)
            .map(|_| {
                vec![Err(Error::Http {
                    status: 503,
                    message: "unavailable".into(),
                    retry_after: None,
                })]
            })
            .collect(),
    ));
    let report = agent(model.clone(), ToolRegistry::new(), 8)
        .run(input())
        .await
        .unwrap();
    assert!(matches!(
        report.status,
        RunStatus::Failed(Error::Http { status: 503, .. })
    ));
    assert_eq!(report.model_calls, 3);
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    for request in &requests[1..] {
        assert_eq!(
            serde_json::to_value(&request.messages).unwrap(),
            serde_json::to_value(&requests[0].messages).unwrap()
        );
    }
}

#[tokio::test]
async fn retry_limits_reset_after_a_committed_tool_step_without_reexecuting_it() {
    let unavailable = || {
        Err(Error::Http {
            status: 503,
            message: "retry".into(),
            retry_after: None,
        })
    };
    let model = Arc::new(ScriptedModel::new(vec![
        vec![unavailable()],
        vec![calls(&[("once", "double", json!({"value":2}))])],
        vec![unavailable()],
        vec![answer("4")],
    ]));
    let count = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Double(count.clone())).unwrap();
    let agent = Agent::new(
        model.clone(),
        tools,
        RunOptions {
            max_retries: 1,
            retry_delay: Duration::ZERO,
            ..Default::default()
        },
    )
    .unwrap();
    let report = agent.run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(report.model_calls, 4);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    validate_history(&report.history).unwrap();
    let requests = model.requests.lock().unwrap();
    assert_eq!(
        serde_json::to_value(&requests[2].messages).unwrap(),
        serde_json::to_value(&requests[3].messages).unwrap()
    );
    assert_eq!(
        requests[3]
            .messages
            .iter()
            .flat_map(|message| message.tool_calls())
            .count(),
        1
    );
}

#[tokio::test]
async fn incomplete_tool_arguments_never_execute() {
    let model = Arc::new(ScriptedModel::new(vec![vec![Ok(
        ModelEvent::ToolCallDelta {
            index: 0,
            arguments: "{\"value\":".into(),
        },
    )]]));
    let count = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Double(count.clone())).unwrap();
    let report = agent(model, tools, 8).run(input()).await.unwrap();
    assert!(matches!(
        report.status,
        RunStatus::Failed(Error::Protocol(_))
    ));
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn truncated_response_does_not_execute_complete_looking_tool_calls() {
    let mut event = calls(&[("a", "double", json!({"value":2}))]).unwrap();
    if let ModelEvent::Finished(response) = &mut event {
        response.finish_reason = FinishReason::Length;
    }
    let model = Arc::new(ScriptedModel::new(vec![vec![Ok(event)]]));
    let count = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Double(count.clone())).unwrap();
    let report = agent(model, tools, 8).run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::Truncated));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert_eq!(report.history.len(), 1);
    assert!(report.pending_turn.unwrap().response.is_some());
}

struct HangingModel(Arc<Mutex<Option<CancellationToken>>>);
impl Model for HangingModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }
    fn generate(&self, _: ModelRequest, context: ExecutionContext) -> ModelStream {
        *self.0.lock().unwrap() = Some(context.cancellation);
        Box::pin(futures::stream::pending())
    }
}

#[tokio::test(start_paused = true)]
async fn deadlines_stop_a_model_that_never_yields() {
    let model = Arc::new(HangingModel(Arc::new(Mutex::new(None))));
    let agent = Agent::new(
        model,
        ToolRegistry::new(),
        RunOptions {
            timeout: Duration::from_secs(1),
            ..RunOptions::default()
        },
    )
    .unwrap();
    let report = agent.run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::TimedOut));
    assert_eq!(report.model_calls, 1);
}

#[tokio::test]
async fn dropping_stream_cancels_its_child_without_cancelling_parent() {
    let observed = Arc::new(Mutex::new(None));
    let model = Arc::new(HangingModel(observed.clone()));
    let input = input();
    let parent = input.cancellation.clone();
    let mut stream = agent(model, ToolRegistry::new(), 8).stream(input).unwrap();
    assert!(matches!(
        stream.next().await,
        Some(AgentEvent::ModelStarted { .. })
    ));
    tokio::select! {_ = stream.next()=>panic!("模型不应完成"),_ = tokio::task::yield_now()=>{}}
    let child = observed.lock().unwrap().clone().unwrap();
    drop(stream);
    assert!(child.is_cancelled());
    assert!(!parent.is_cancelled());
}

#[tokio::test]
async fn cancellation_after_one_tool_preserves_result_and_pending_batch() {
    let model = Arc::new(ScriptedModel::new(vec![vec![calls(&[
        ("a", "double", json!({"value":2})),
        ("b", "double", json!({"value":3})),
    ])]]));
    let count = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Double(count.clone())).unwrap();
    let input = input();
    let token = input.cancellation.clone();
    let mut stream = agent(model, tools, 8).stream(input).unwrap();
    let report = loop {
        match stream.next().await.unwrap() {
            AgentEvent::ToolFinished(_) => token.cancel(),
            AgentEvent::Finished(report) => break report,
            _ => {}
        }
    };
    assert!(matches!(report.status, RunStatus::Cancelled));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(report.history.len(), 1);
    let pending = report.pending_turn.unwrap();
    assert_eq!(pending.tool_results[0].call_id, "a");
    assert_eq!(pending.attempted_tool_ids, vec!["a"]);
}

#[tokio::test]
async fn events_after_completion_are_protocol_failures() {
    let model = Arc::new(ScriptedModel::new(vec![vec![
        answer("完成"),
        Ok(ModelEvent::TextDelta("非法尾部".into())),
    ]]));
    let report = agent(model, ToolRegistry::new(), 8)
        .run(input())
        .await
        .unwrap();
    assert!(matches!(
        report.status,
        RunStatus::Failed(Error::Protocol(_))
    ));
    assert_eq!(report.history.len(), 1);
}

#[tokio::test]
async fn cancellation_between_start_event_and_model_invocation_stops_dispatch() {
    let model = Arc::new(ScriptedModel::new(vec![vec![answer("不应请求")]]));
    let input = input();
    let token = input.cancellation.clone();
    let mut stream = agent(model.clone(), ToolRegistry::new(), 8)
        .stream(input)
        .unwrap();
    assert!(matches!(
        stream.next().await,
        Some(AgentEvent::ModelStarted { .. })
    ));
    token.cancel();
    assert!(
        matches!(stream.next().await,Some(AgentEvent::Finished(report))if matches!(report.status,RunStatus::Cancelled))
    );
    assert!(model.requests.lock().unwrap().is_empty());
}
