use crate::{ContentPart, Message};

/// 模型保留最近三次浏览器视觉观察；完整历史与文字证据不变，避免长任务反复发送旧截图。
pub(super) fn for_model(history: &[Message]) -> Vec<Message> {
    let mut messages = history.to_vec();
    let mut retained = 0;
    for message in messages.iter_mut().rev() {
        for part in message.content.iter_mut().rev() {
            if let ContentPart::ToolResult(result) = part
                && result.name == "browser"
                && !result.media.is_empty()
            {
                retained += 1;
                if retained > 3 {
                    result.media.clear();
                    if let Some(output) = result.output.as_object_mut() {
                        output.insert(
                            "image_omitted".into(),
                            serde_json::Value::String(
                                "旧截图未重新发送；文字观察仍保留，需要视觉状态时重新 screenshot"
                                    .into(),
                            ),
                        );
                    }
                }
            }
        }
    }
    messages
}
