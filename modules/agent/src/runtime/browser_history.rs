use crate::{ContentPart, Media, Message};

/// 按本轮视觉能力投影最近三张界面截图；完整历史、文字证据和其他附件保持原样。
pub(super) fn for_model(history: &[Message], vision: bool) -> Vec<Message> {
    let mut messages = history.to_vec();
    let mut retained = 0;
    for message in messages.iter_mut().rev() {
        for part in message.content.iter_mut().rev() {
            if let ContentPart::ToolResult(result) = part
                && matches!(result.name.as_str(), "browser" | "ui_repl")
                && result
                    .media
                    .iter()
                    .any(|media| matches!(media, Media::Image(_)))
            {
                let mut omitted = false;
                result.media.reverse();
                result.media.retain(|media| {
                    if matches!(media, Media::Image(_)) {
                        retained += 1;
                        let keep = vision && retained <= 3;
                        omitted |= !keep;
                        keep
                    } else {
                        true
                    }
                });
                result.media.reverse();
                if omitted && let Some(output) = result.output.as_object_mut() {
                    output.insert(
                            "image_omitted".into(),
                            serde_json::Value::String(
                                if vision {
                                    "旧截图未重新发送；文字观察仍保留，需要视觉状态时重新 screenshot"
                                } else {
                                    "当前模型未声明视觉能力，界面截图未发送；文字观察与原始截图历史仍保留"
                                }.into(),
                            ),
                        );
                }
            }
        }
    }
    messages
}
