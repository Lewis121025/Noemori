#[path = "../../../../modules/agent/src/tool/terminal/buffer.rs"]
mod buffer;

use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, ToolCall,
    tool::{
        ToolRegistry,
        terminal::{SandboxMode, TerminalTool},
    },
};
use serde_json::{Value, json};
use std::time::Duration;

#[test]
fn bounded_buffer_retains_both_ends_and_counts_unicode_omissions() {
    let mut buffer = buffer::OutputBuffer::new(512);
    let text = format!("开始{}结束", "中".repeat(1000));
    buffer.push(&text);
    let (output, omitted) = buffer.take(256);
    assert!(output.starts_with("开始"));
    assert!(output.ends_with("结束"));
    assert!(output.chars().count() <= 256);
    assert_eq!(omitted, 1004 - 192);
    assert!(output.contains(&format!("已省略 {omitted} 个字符")));
    assert_eq!(buffer.take(256), (String::new(), 0));
    buffer.push("新的输出🙂");
    assert_eq!(buffer.take(256), ("新的输出🙂".into(), 0));
}

#[test]
fn output_budget_truncates_even_when_internal_buffer_has_space() {
    let mut buffer = buffer::OutputBuffer::new(2048);
    buffer.push(&"a".repeat(300));
    let (output, omitted) = buffer.take(256);
    assert_eq!(omitted, 108);
    assert!(output.chars().count() <= 256);
}

#[cfg(unix)]
#[tokio::test]
async fn schema_rejects_invalid_actions_fields_and_limits_before_spawning() {
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::configured(std::env::temp_dir(), "/bin/sh", SandboxMode::Disabled)
                .unwrap(),
        )
        .unwrap();
    let session = AgentSession::new();
    for arguments in [
        json!({"action":"exec"}),
        json!({"action":"other"}),
        json!({"action":"exec","cmd":"true","unexpected":1}),
        json!({"action":"list","cmd":"true"}),
        json!({"action":"exec","cmd":"true","timeout_ms":0}),
        json!({"action":"exec","cmd":"true","yield_time_ms":30001}),
        json!({"action":"exec","cmd":"true","max_output_chars":255}),
        json!({"action":"interact","session_id":"x","input":"x".repeat(16385)}),
        json!({"action":"stop","session_id":""}),
    ] {
        let result = call(&tools, &session, arguments).await;
        assert!(result.is_error, "{result:?}");
        assert!(result.output["error"].as_str().unwrap().contains("Schema"));
    }
    assert_eq!(
        call(&tools, &session, json!({"action":"list"}))
            .await
            .output,
        json!({"terminals":[]})
    );
    session.close().await.unwrap();
}

async fn call(
    tools: &ToolRegistry,
    session: &AgentSession,
    arguments: Value,
) -> noemori_agent::ToolResult {
    tools
        .execute_in_session(
            &ToolCall {
                id: "test".into(),
                name: "terminal".into(),
                arguments,
            },
            ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap(),
            session,
        )
        .await
        .unwrap()
}
