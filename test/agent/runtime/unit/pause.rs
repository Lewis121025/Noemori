use super::*;
use crate::{
    ContentPart, Role, ToolCall,
    llm::{FinishReason, Usage},
};

#[test]
fn paused_tool_groups_close_unknown_and_unstarted_calls_without_replaying_them() {
    let mut state = RunState::new(vec![Message::text(Role::User, "操作页面")]);
    state.begin_model();
    let calls = ["started", "unstarted"].map(|id| ToolCall {
        id: id.into(),
        name: "browser".into(),
        arguments: serde_json::json!({"action":"click"}),
    });
    state
        .response(ModelResponse {
            message: Message {
                role: Role::Assistant,
                content: calls.iter().cloned().map(ContentPart::ToolCall).collect(),
                provider_data: None,
            },
            finish_reason: FinishReason::ToolCalls,
            usage: Usage::default(),
            response_id: None,
        })
        .unwrap();
    state.pending_mut().unwrap().model_completed = true;
    state
        .pending_mut()
        .unwrap()
        .attempted_tool_ids
        .push("started".into());
    let results = state.pause_turn();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].call_id, "started");
    assert_eq!(results[0].output["outcome"], "unknown");
    assert_eq!(results[1].call_id, "unstarted");
    assert_eq!(results[1].output["outcome"], "not_executed");
    state.commit().unwrap();
    validate_history(&state.history).unwrap();
    assert!(state.pending.is_none());
}
