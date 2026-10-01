#[path = "../../support/model.rs"]
mod support;

use noemori_agent::llm::{Capabilities, ModelEvent, ModelRequest, generate};
use noemori_agent::tool::ToolDefinition;
use noemori_agent::{CancellationToken, Error, ExecutionContext, Message, Role};
use serde_json::json;
use std::time::Duration;
use support::{ScriptedModel, answer, calls};

fn request() -> ModelRequest {
    ModelRequest::new(vec![Message::text(Role::User, "测试输入")])
}

fn capabilities() -> Capabilities {
    Capabilities {
        tools: true,
        streaming: true,
    }
}

#[tokio::test]
async fn cancelled_direct_generation_never_enters_the_model() {
    let model = ScriptedModel::new(vec![vec![answer("不应生成")]]);
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(10)).unwrap();
    context.cancellation.cancel();
    assert!(matches!(
        generate(&model, request(), context).await,
        Err(Error::Cancelled)
    ));
    assert!(model.requests.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn expired_direct_generation_never_enters_the_model() {
    let model = ScriptedModel::new(vec![vec![answer("不应生成")]]);
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(1)).unwrap();
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(matches!(
        generate(&model, request(), context).await,
        Err(Error::Timeout)
    ));
    assert!(model.requests.lock().unwrap().is_empty());
}

#[test]
fn direct_tool_declarations_reject_invalid_names() {
    for name in ["a/b".to_owned(), "a".repeat(65)] {
        let mut request = request();
        request.tools.push(ToolDefinition {
            name,
            description: "测试工具".into(),
            input_schema: json!({"type":"object"}),
        });
        assert!(matches!(
            request.validate(capabilities()),
            Err(Error::Config(_))
        ));
    }
}

#[test]
fn direct_tool_declarations_reject_invalid_schemas() {
    let mut request = request();
    request.tools.push(ToolDefinition {
        name: "test".into(), description: "测试工具".into(),
        input_schema: json!({"type":"object","properties":{"value":{"type":"not-a-json-schema-type"}}}),
    });
    assert!(matches!(
        request.validate(capabilities()),
        Err(Error::Config(_))
    ));
}

#[test]
fn empty_text_is_not_a_successful_model_response() {
    let ModelEvent::Finished(response) = answer("").unwrap() else {
        unreachable!()
    };
    assert!(matches!(response.validate(), Err(Error::Protocol(_))));
}

#[test]
fn complete_tool_calls_satisfy_the_response_contract() {
    let ModelEvent::Finished(response) = calls(&[("call-1", "test", json!({"value":1}))]).unwrap()
    else {
        unreachable!()
    };
    response.validate().unwrap();
}

#[tokio::test]
async fn direct_generation_rejects_call_ids_already_present_in_history() {
    let ModelEvent::Finished(previous) = calls(&[("call-1", "test", json!({}))]).unwrap() else {
        unreachable!()
    };
    let mut request = request();
    request.messages.push(previous.message);
    request
        .messages
        .push(Message::tool_results(vec![noemori_agent::ToolResult {
            call_id: "call-1".into(),
            name: "test".into(),
            output: json!("done"),
            is_error: false,
        }]));
    let model = ScriptedModel::new(vec![vec![calls(&[("call-1", "test", json!({}))])]]);
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(10)).unwrap();
    assert!(matches!(
        generate(&model, request, context).await,
        Err(Error::Protocol(_))
    ));
}

#[test]
fn local_schema_references_remain_valid_without_external_resolution() {
    let definition = ToolDefinition {
        name: "test".into(),
        description: "嵌套参数".into(),
        input_schema: json!({"type":"object","properties":{"value":{"$ref":"#/$defs/value"}},"$defs":{"value":{"type":"integer","minimum":1}}}),
    };
    definition.validate().unwrap();
}
