use noemori_agent::{ContentPart, Message, Role, ToolCall, ToolResult, validate_history};
use serde_json::json;

#[test]
fn history_requires_exact_call_result_pairing() {
    let user = Message::text(Role::User, "hello");
    let assistant = Message {
        role: Role::Assistant,
        content: vec![ContentPart::ToolCall(ToolCall {
            id: "call-1".into(),
            name: "count".into(),
            arguments: json!({"count":1}),
        })],
        provider_data: None,
    };
    assert!(validate_history(&[user.clone(), assistant.clone()]).is_err());
    let result = ToolResult {
        call_id: "call-1".into(),
        name: "count".into(),
        output: json!(1),
        is_error: false,
        media: Vec::new(),
    };
    let history = vec![user, assistant, Message::tool_results(vec![result.clone()])];
    validate_history(&history).unwrap();
    let mut invalid = history.clone();
    invalid.push(Message::tool_results(vec![result]));
    assert!(validate_history(&invalid).is_err());
    let encoded = serde_json::to_vec(&history).unwrap();
    assert_eq!(
        serde_json::from_slice::<Vec<Message>>(&encoded).unwrap(),
        history
    );
}
