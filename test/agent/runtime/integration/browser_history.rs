use super::*;
use noemori_agent::{ContentPart, Image, ImageFormat, Media, ToolCall, ToolResult};

fn image() -> Image {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=").unwrap();
    Image::new(ImageFormat::Png, bytes).unwrap()
}

struct VisionModel(ScriptedModel);
impl Model for VisionModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            vision: true,
            ..self.0.capabilities()
        }
    }
    fn generate(&self, request: ModelRequest, context: ExecutionContext) -> ModelStream {
        self.0.generate(request, context)
    }
}

#[tokio::test]
async fn text_model_does_not_silently_discard_user_attachments_or_other_tool_images() {
    for name in [None, Some("web")] {
        let mut messages = vec![Message::text(Role::User, "保留必要图像")];
        if let Some(name) = name {
            messages.push(Message {
                role: Role::Assistant,
                provider_data: None,
                content: vec![ContentPart::ToolCall(ToolCall {
                    id: "image".into(),
                    name: name.into(),
                    arguments: json!({}),
                })],
            });
            messages.push(Message::tool_results(vec![ToolResult {
                call_id: "image".into(),
                name: name.into(),
                output: json!({}),
                is_error: false,
                media: vec![Media::Image(image())],
            }]));
        } else {
            messages[0].content.push(ContentPart::Image(image()));
        }
        let model = Arc::new(ScriptedModel::new(vec![]));
        let outcome = agent(model.clone(), ToolRegistry::new(), 1)
            .run(RunInput::new(messages))
            .await;
        assert!(matches!(outcome, Err(Error::Unsupported(_))));
        assert!(model.requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn text_model_uses_browser_observations_without_images_and_preserves_saved_media() {
    let image = image();
    let messages = vec![
        Message::text(Role::User, "查看网页"),
        Message {
            role: Role::Assistant,
            provider_data: None,
            content: vec![ContentPart::ToolCall(ToolCall {
                id: "capture".into(),
                name: "browser".into(),
                arguments: json!({}),
            })],
        },
        Message::tool_results(vec![ToolResult {
            call_id: "capture".into(),
            name: "browser".into(),
            output: json!({"text":"页面上已确认的文字事实"}),
            is_error: false,
            media: vec![Media::Image(image)],
        }]),
        Message::text(Role::User, "使用新的文字模型继续"),
    ];
    let original = messages.clone();
    let model = Arc::new(ScriptedModel::new(vec![vec![answer("按文字事实继续")]]));
    let report = agent(model.clone(), ToolRegistry::new(), 1)
        .run(RunInput::new(messages))
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(&report.history[..original.len()], original);
    let requests = model.requests.lock().unwrap();
    let ContentPart::ToolResult(result) = &requests[0].messages[2].content[0] else {
        panic!("缺少工具结果")
    };
    assert!(result.media.is_empty());
    assert_eq!(result.output["text"], "页面上已确认的文字事实");
    assert!(
        result.output["image_omitted"]
            .as_str()
            .unwrap()
            .contains("视觉")
    );
}

#[tokio::test]
async fn old_browser_images_are_bounded_without_mutating_saved_history_or_other_media() {
    let image = image();
    let mut messages = vec![Message::text(Role::User, "保留每页的文字证据")];
    for index in 0..6 {
        let id = format!("capture-{index}");
        let name = if index == 0 { "web" } else { "browser" };
        messages.push(Message {
            role: Role::Assistant,
            provider_data: None,
            content: vec![ContentPart::ToolCall(ToolCall {
                id: id.clone(),
                name: name.into(),
                arguments: json!({}),
            })],
        });
        messages.push(Message::tool_results(vec![ToolResult {
            call_id: id,
            name: name.into(),
            output: json!({"text":format!("第{index}页证据")}),
            is_error: false,
            media: vec![Media::Image(image.clone())],
        }]));
    }
    let original = messages.clone();
    let model = Arc::new(VisionModel(ScriptedModel::new(vec![vec![answer("完成")]])));
    let report = agent(model.clone(), ToolRegistry::new(), 1)
        .run(RunInput::new(messages))
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(&report.history[..original.len()], original);
    let requests = model.0.requests.lock().unwrap();
    validate_history(&requests[0].messages).unwrap();
    let results: Vec<_> = requests[0]
        .messages
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|part| {
            if let ContentPart::ToolResult(result) = part {
                Some(result)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(results[0].media.len(), 1);
    assert!(results[1].media.is_empty());
    assert!(results[2].media.is_empty());
    assert_eq!(
        results
            .iter()
            .filter(|result| result.name == "browser" && !result.media.is_empty())
            .count(),
        3
    );
    assert_eq!(results[1].output["text"], "第1页证据");
}
