use crate::{ContentPart, Media, Message};

/// 按本轮视觉能力投影最近三次浏览器截图；完整历史、文字证据和其他附件保持原样。
pub(super) fn for_model(history: &[Message], vision: bool) -> Vec<Message> {
    let mut messages = history.to_vec();
    let mut retained = 0;
    for message in messages.iter_mut().rev() {
        for part in message.content.iter_mut().rev() {
            if let ContentPart::ToolResult(result) = part
                && result.name == "browser"
                && result
                    .media
                    .iter()
                    .any(|media| matches!(media, Media::Image(_)))
            {
                retained += 1;
                if !vision || retained > 3 {
                    result
                        .media
                        .retain(|media| !matches!(media, Media::Image(_)));
                    if let Some(output) = result.output.as_object_mut() {
                        output.insert(
                            "image_omitted".into(),
                            serde_json::Value::String(
                                if vision {
                                    "旧截图未重新发送；文字观察仍保留，需要视觉状态时重新 screenshot"
                                } else {
                                    "当前模型未声明视觉能力，浏览器截图未发送；文字观察与原始截图历史仍保留"
                                }.into(),
                            ),
                        );
                    }
                }
            }
        }
    }
    messages
}
