use super::{ScriptedModel, answer, calls, input};
use async_trait::async_trait;
use futures::StreamExt;
use noemori_agent::{
    runtime::{Agent, AgentEvent, RunOptions, RunStatus},
    tool::{Tool, ToolConcurrency, ToolContext, ToolError, ToolRegistry},
};
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

#[derive(Deserialize, JsonSchema)]
struct Args {
    value: u32,
    delay_ms: u64,
}

#[derive(Default)]
struct Activity {
    active: AtomicUsize,
    peak: AtomicUsize,
    events: Mutex<Vec<(u32, bool)>>,
}

struct Probe {
    name: &'static str,
    concurrency: ToolConcurrency,
    activity: Arc<Activity>,
}

struct Active(Arc<Activity>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl Tool for Probe {
    type Args = Args;
    type Output = u32;
    fn name(&self) -> &str {
        self.name
    }
    fn description(&self) -> &str {
        "检查并发与屏障"
    }
    fn concurrency(&self, _: &Args) -> ToolConcurrency {
        self.concurrency
    }
    async fn execute(&self, args: Args, _: ToolContext) -> Result<u32, ToolError> {
        let active = self.activity.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.activity.peak.fetch_max(active, Ordering::SeqCst);
        let _active = Active(self.activity.clone());
        self.activity
            .events
            .lock()
            .unwrap()
            .push((args.value, false));
        tokio::time::sleep(Duration::from_millis(args.delay_ms)).await;
        self.activity
            .events
            .lock()
            .unwrap()
            .push((args.value, true));
        Ok(args.value)
    }
}

fn registry(activity: &Arc<Activity>) -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    for (name, concurrency) in [
        ("read", ToolConcurrency::Concurrent),
        ("write", ToolConcurrency::Sequential),
    ] {
        tools
            .register(Probe {
                name,
                concurrency,
                activity: activity.clone(),
            })
            .unwrap();
    }
    tools
}

#[tokio::test(start_paused = true)]
async fn concurrent_calls_overlap_but_history_keeps_model_order_and_writes_are_barriers() {
    let activity = Arc::new(Activity::default());
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&[
            ("a", "read", json!({"value":1,"delay_ms":90})),
            ("b", "read", json!({"value":2,"delay_ms":10})),
            ("c", "write", json!({"value":3,"delay_ms":20})),
            ("d", "read", json!({"value":4,"delay_ms":10})),
        ])],
        vec![answer("done")],
    ]));
    let agent = Agent::new(model.clone(), registry(&activity), RunOptions::default()).unwrap();
    let report = agent.run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(activity.peak.load(Ordering::SeqCst), 2);
    assert_eq!(
        *activity.events.lock().unwrap(),
        vec![
            (1, false),
            (2, false),
            (2, true),
            (1, true),
            (3, false),
            (3, true),
            (4, false),
            (4, true)
        ]
    );
    let requests = model.requests.lock().unwrap();
    let results: Vec<_> = requests[1]
        .messages
        .last()
        .unwrap()
        .content
        .iter()
        .filter_map(|part| match part {
            noemori_agent::ContentPart::ToolResult(result) => Some(result.call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(results, ["a", "b", "c", "d"]);
}

#[tokio::test(start_paused = true)]
async fn all_concurrent_calls_start_without_a_count_limit_and_keep_model_order() {
    let activity = Arc::new(Activity::default());
    let ids: Vec<_> = (0..128).map(|index| format!("call-{index}")).collect();
    let requests: Vec<_> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            (
                id.as_str(),
                "read",
                json!({"value":index,"delay_ms":ids.len() - index}),
            )
        })
        .collect();
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&requests)],
        vec![answer("done")],
    ]));
    let agent = Agent::new(model.clone(), registry(&activity), RunOptions::default()).unwrap();
    let report = agent.run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(activity.peak.load(Ordering::SeqCst), ids.len());
    assert_eq!(activity.active.load(Ordering::SeqCst), 0);
    let events = activity.events.lock().unwrap();
    assert!(events[..ids.len()].iter().all(|(_, finished)| !finished));
    assert_eq!(
        events[ids.len()..]
            .iter()
            .map(|(value, _)| *value)
            .collect::<Vec<_>>(),
        (0..128).rev().collect::<Vec<_>>()
    );
    let requests = model.requests.lock().unwrap();
    let results: Vec<_> = requests[1]
        .messages
        .last()
        .unwrap()
        .content
        .iter()
        .filter_map(|part| match part {
            noemori_agent::ContentPart::ToolResult(result) => Some(result.call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(results, ids.iter().map(String::as_str).collect::<Vec<_>>());
}

#[tokio::test(start_paused = true)]
async fn cancelling_a_large_group_keeps_results_and_does_not_cross_the_sequential_barrier() {
    let activity = Arc::new(Activity::default());
    let ids: Vec<_> = (0..128).map(|index| format!("call-{index}")).collect();
    let mut requests: Vec<_> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            (
                id.as_str(),
                "read",
                json!({"value":index,"delay_ms":ids.len() - index}),
            )
        })
        .collect();
    requests.extend([
        ("barrier", "write", json!({"value":128,"delay_ms":1})),
        ("after", "read", json!({"value":129,"delay_ms":1})),
    ]);
    let model = Arc::new(ScriptedModel::new(vec![vec![calls(&requests)]]));
    let agent = Agent::new(model.clone(), registry(&activity), RunOptions::default()).unwrap();
    let input = input();
    let cancellation = input.cancellation.clone();
    let mut stream = agent.stream(input).unwrap();
    let mut started = Vec::new();
    let mut report = None;
    while let Some(event) = stream.next().await {
        match event {
            AgentEvent::ToolStarted(call) => started.push(call.id),
            AgentEvent::ToolFinished(result) => {
                assert_eq!(result.call_id, "call-127");
                cancellation.cancel();
            }
            AgentEvent::Finished(result) => report = Some(result),
            _ => {}
        }
    }
    let report = report.unwrap();
    assert!(matches!(report.status, RunStatus::Cancelled));
    assert_eq!(started, ids);
    assert_eq!(activity.peak.load(Ordering::SeqCst), ids.len());
    assert_eq!(activity.active.load(Ordering::SeqCst), 0);
    assert_eq!(report.history.len(), 1);
    let pending = report.pending_turn.unwrap();
    assert_eq!(pending.attempted_tool_ids, ids);
    assert_eq!(pending.tool_results.len(), 1);
    assert_eq!(pending.tool_results[0].call_id, "call-127");
    assert_eq!(activity.events.lock().unwrap().last(), Some(&(127, true)));
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn timeout_cancels_all_concurrent_calls_and_retains_completed_results() {
    let activity = Arc::new(Activity::default());
    let model = Arc::new(ScriptedModel::new(vec![vec![calls(&[
        ("a", "read", json!({"value":1,"delay_ms":1000})),
        ("b", "read", json!({"value":2,"delay_ms":10})),
        ("c", "read", json!({"value":3,"delay_ms":10})),
    ])]]));
    let agent = Agent::new(
        model,
        registry(&activity),
        RunOptions {
            timeout: Duration::from_millis(50),
            ..Default::default()
        },
    )
    .unwrap();
    let report = agent.run(input()).await.unwrap();
    assert!(matches!(report.status, RunStatus::TimedOut));
    assert_eq!(activity.peak.load(Ordering::SeqCst), 3);
    assert_eq!(activity.active.load(Ordering::SeqCst), 0);
    let pending = report.pending_turn.unwrap();
    assert_eq!(pending.attempted_tool_ids, ["a", "b", "c"]);
    assert_eq!(
        pending
            .tool_results
            .iter()
            .map(|result| result.call_id.as_str())
            .collect::<Vec<_>>(),
        ["b", "c"]
    );
    assert_eq!(report.history.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn tool_declared_sequential_calls_do_not_overlap() {
    let activity = Arc::new(Activity::default());
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&[
            ("a", "read", json!({"value":1,"delay_ms":10})),
            ("b", "read", json!({"value":2,"delay_ms":10})),
        ])],
        vec![answer("done")],
    ]));
    let mut tools = ToolRegistry::new();
    tools
        .register(Probe {
            name: "read",
            concurrency: ToolConcurrency::Sequential,
            activity: activity.clone(),
        })
        .unwrap();
    let agent = Agent::new(model, tools, RunOptions::default()).unwrap();
    assert!(matches!(
        agent.run(input()).await.unwrap().status,
        RunStatus::Completed
    ));
    assert_eq!(activity.peak.load(Ordering::SeqCst), 1);
}

static DECODE_COUNT: AtomicUsize = AtomicUsize::new(0);
fn next_decode() -> usize {
    DECODE_COUNT.fetch_add(1, Ordering::SeqCst) + 1
}

#[derive(Deserialize, JsonSchema)]
struct ParsedArgs {
    value: usize,
    #[serde(skip, default = "next_decode")]
    generation: usize,
}

struct ParsedOnce;
#[async_trait]
impl Tool for ParsedOnce {
    type Args = ParsedArgs;
    type Output = usize;
    fn name(&self) -> &str {
        "parsed_once"
    }
    fn description(&self) -> &str {
        "保证调度和执行持有同一份已校验参数"
    }
    fn concurrency(&self, _: &ParsedArgs) -> ToolConcurrency {
        ToolConcurrency::Concurrent
    }
    async fn execute(&self, args: ParsedArgs, _: ToolContext) -> Result<usize, ToolError> {
        assert_eq!(args.generation, args.value, "参数不能在执行时重新构造");
        Ok(args.value)
    }
}

#[tokio::test]
async fn scheduling_and_execution_share_one_validated_argument_instance() {
    DECODE_COUNT.store(0, Ordering::SeqCst);
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&[
            ("a", "parsed_once", json!({"value":1})),
            ("b", "parsed_once", json!({"value":2})),
        ])],
        vec![answer("done")],
    ]));
    let mut tools = ToolRegistry::new();
    tools.register(ParsedOnce).unwrap();
    let agent = Agent::new(model, tools, RunOptions::default()).unwrap();
    assert!(matches!(
        agent.run(input()).await.unwrap().status,
        RunStatus::Completed
    ));
    assert_eq!(DECODE_COUNT.load(Ordering::SeqCst), 2);
}
