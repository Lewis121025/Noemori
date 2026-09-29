#[path = "../../support/http.rs"]
mod support;

use nous_agent::llm::{
    Authentication, Capabilities, FinishReason, HttpModel, ModelConfig, ModelRequest, Protocol,
    generate,
};
use nous_agent::{CancellationToken, Error, ExecutionContext, Message, Role, ToolResult};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use support::{Fixture, Server};

fn context() -> ExecutionContext {
    ExecutionContext::new(CancellationToken::new(), Duration::from_secs(10)).unwrap()
}
fn request() -> ModelRequest {
    ModelRequest::new(vec![
        Message::text(Role::System, "请用中文"),
        Message::text(Role::User, "你好"),
    ])
}
fn config(protocol: Protocol, url: &str, streaming: bool) -> ModelConfig {
    let mut config = ModelConfig::new(protocol, "test-model", url);
    config.capabilities = Capabilities {
        tools: true,
        streaming,
    };
    config
}
fn chat(text: &str) -> Value {
    json!({"id":"r1","choices":[{"message":{"role":"assistant","content":text},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}})
}
fn chat_chunk(delta: Value, finish: Value) -> Value {
    json!({"id":"r1","choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
}

fn bedrock_fixture(events: &[(&str, Value)]) -> Fixture {
    use aws_smithy_types::event_stream::{Header, HeaderValue, Message};
    let mut body = Vec::new();
    for (kind, payload) in events {
        let message = Message::new_from_parts(
            vec![
                Header::new(":message-type", HeaderValue::String("event".into())),
                Header::new(
                    ":event-type",
                    HeaderValue::String((*kind).to_owned().into()),
                ),
            ],
            bytes::Bytes::from(payload.to_string()),
        );
        aws_smithy_eventstream::frame::write_message_to(&message, &mut body).unwrap();
    }
    Fixture {
        status: 200,
        content_type: "application/vnd.amazon.eventstream",
        body,
    }
}

mod anthropic;
mod bedrock;
mod contracts;
mod gemini;
mod ollama;
mod openai;
