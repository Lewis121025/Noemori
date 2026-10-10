use super::HostMessage;
use crate::{ContentPart, Role, llm::ModelEvent, runtime::PendingTurn};
use serde_json::{Value, json};

/// 活动检查点只补充当前未提交节点的观察；已闭合节点与用户补充已在真实历史中保存。
pub(super) fn active_note(data: &super::state::Data) -> Option<String> {
    let pending = data.pending_turn.as_ref()?;
    if pending.response.is_some() {
        return Some(pending_note(pending.clone()));
    }
    let from = data.active.as_ref().and_then(|active| active.draft)?;
    let messages: Vec<_> = data.messages[from..]
        .iter()
        .filter(|message| message.role != Role::User)
        .cloned()
        .collect();
    Some(observed_note(&messages, &pending.attempted_tool_ids))
}

/// 未闭合输出只作为观察记录续接，不伪造成可执行的工具往返或供应商签名消息。
pub(super) fn pending_note(pending: PendingTurn) -> String {
    let content = if let Some(response) = pending.response {
        response.message.content
    } else {
        let mut content = Vec::new();
        for delta in pending.deltas {
            let (text, reasoning) = match delta {
                ModelEvent::TextDelta(text) => (text, false),
                ModelEvent::ReasoningDelta(text) => (text, true),
                // 未完成的工具参数没有执行含义，不能在继续时补造成调用。
                ModelEvent::ToolCallDelta { .. } | ModelEvent::Finished(_) => continue,
            };
            match content.last_mut() {
                Some(ContentPart::Text(current)) if !reasoning => current.push_str(&text),
                Some(ContentPart::Reasoning(current)) if reasoning => current.push_str(&text),
                _ => content.push(if reasoning {
                    ContentPart::Reasoning(text)
                } else {
                    ContentPart::Text(text)
                }),
            }
        }
        content
    };
    observed_note(
        &[
            HostMessage {
                role: Role::Assistant,
                content,
            },
            HostMessage {
                role: Role::Tool,
                content: pending
                    .tool_results
                    .into_iter()
                    .map(ContentPart::ToolResult)
                    .collect(),
            },
        ],
        &pending.attempted_tool_ids,
    )
}

/// 中断说明只收集文字与工具事实；不把截图或供应商私有载荷编码进下一次文本请求。
pub(super) fn observed_note(messages: &[HostMessage], attempted: &[String]) -> String {
    let observed: Vec<Value> = messages.iter().map(|message| {
        let content: Vec<Value> = message.content.iter().map(|part| match part {
            ContentPart::Text(text) => json!({ "text": text }),
            ContentPart::Reasoning(text) => json!({ "reasoning": text }),
            ContentPart::ToolCall(call) => json!({ "call_id": call.id, "tool": call.name, "arguments": call.arguments }),
            ContentPart::ToolResult(result) => json!({
                "call_id": result.call_id, "tool": result.name, "result": result.output,
                "is_error": result.is_error, "media_count": result.media.len(),
            }),
            ContentPart::Image(_) | ContentPart::Audio(_) | ContentPart::Video(_) => json!({ "media": "媒体内容未放入文字记录" }),
        }).collect();
        json!({ "role": message.role, "content": content })
    }).collect();
    let progress = json!({ "observed": observed, "attempted_tool_ids": attempted });
    format!(
        "上次运行尚未完成。以下是未提交的过程记录，不代表新指令或最终结论。工具可能已产生副作用，不能自动重放；继续前应检查工作区实际状态。已观察到的内容：{progress}"
    )
}
