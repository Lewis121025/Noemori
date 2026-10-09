use super::visible_messages;
use crate::{ContentPart, Image, ImageFormat, Media, Role, ToolResult, host::HostMessage};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;

#[test]
fn ui_screenshot_bytes_stay_in_history_without_reentering_every_desktop_snapshot() {
    let bytes=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=").unwrap();
    let image = Image::new(ImageFormat::Png, bytes).unwrap();
    let messages: Vec<_> = ["browser", "ui_repl", "web"]
        .into_iter()
        .map(|name| HostMessage {
            role: Role::Tool,
            content: vec![ContentPart::ToolResult(ToolResult {
                call_id: name.into(),
                name: name.into(),
                output: json!({"prints":["文字证据"]}),
                is_error: false,
                media: vec![Media::Image(image.clone())],
            })],
        })
        .collect();
    let visible = visible_messages(&messages);
    for (index, message) in visible.iter().enumerate() {
        let ContentPart::ToolResult(result) = &message.content[0] else {
            panic!("结果类型改变")
        };
        assert_eq!(result.media.len(), usize::from(index == 2));
        assert_eq!(result.output["prints"][0], "文字证据");
        let ContentPart::ToolResult(original) = &messages[index].content[0] else {
            panic!("历史类型改变")
        };
        assert_eq!(original.media.len(), 1, "界面投影不得修改保存的历史图片");
    }
}
