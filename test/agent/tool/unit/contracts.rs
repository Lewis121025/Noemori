use async_trait::async_trait;
use noemori_agent::tool::{Tool, ToolContext, ToolError, ToolRegistry};
use noemori_agent::{CancellationToken, ExecutionContext, ToolCall};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Args {
    #[schemars(range(min = 1, max = 10))]
    count: u32,
}

struct Counter(Arc<AtomicUsize>);

#[async_trait]
impl Tool for Counter {
    type Args = Args;
    type Output = u32;
    fn name(&self) -> &str {
        "count"
    }
    fn description(&self) -> &str {
        "验证合法参数才进入执行"
    }
    async fn execute(&self, args: Args, _: ToolContext) -> Result<u32, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(args.count)
    }
}

fn context() -> ExecutionContext {
    ExecutionContext::new(CancellationToken::new(), Duration::from_secs(10)).unwrap()
}
fn call(args: serde_json::Value) -> ToolCall {
    ToolCall {
        id: "call-1".into(),
        name: "count".into(),
        arguments: args,
    }
}

#[tokio::test]
async fn schema_rejects_invalid_arguments_before_execution() {
    let executions = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Counter(executions.clone())).unwrap();
    for args in [
        json!({"count":0}),
        json!({"count":11}),
        json!({"count":"3"}),
        json!({"count":3,"extra":true}),
        json!({}),
    ] {
        let result = tools.execute(&call(args), context()).await.unwrap();
        assert!(result.is_error);
        assert_eq!(executions.load(Ordering::SeqCst), 0);
    }
    let result = tools
        .execute(&call(json!({"count":3})), context())
        .await
        .unwrap();
    assert_eq!(result.output, json!(3));
    assert!(!result.is_error);
    assert_eq!(executions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn registration_is_atomic_and_clones_are_snapshots() {
    let mut tools = ToolRegistry::new();
    tools
        .register(Counter(Arc::new(AtomicUsize::new(0))))
        .unwrap();
    assert!(
        tools
            .register(Counter(Arc::new(AtomicUsize::new(0))))
            .is_err()
    );
    let snapshot = tools.clone();
    assert!(tools.remove("count"));
    assert!(
        tools
            .execute(&call(json!({"count":1})), context())
            .await
            .unwrap()
            .is_error
    );
    assert!(
        !snapshot
            .execute(&call(json!({"count":1})), context())
            .await
            .unwrap()
            .is_error
    );
}

#[tokio::test]
async fn cancelled_tool_never_executes() {
    let executions = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Counter(executions.clone())).unwrap();
    let context = context();
    context.cancellation.cancel();
    assert!(matches!(
        tools.execute(&call(json!({"count":1})), context).await,
        Err(noemori_agent::Error::Cancelled)
    ));
    assert_eq!(executions.load(Ordering::SeqCst), 0);
}
