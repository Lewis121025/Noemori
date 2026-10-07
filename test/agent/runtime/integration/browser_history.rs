use super::*;
use noemori_agent::{ContentPart, Image, ImageFormat, Media, ToolCall, ToolResult};

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
async fn old_browser_images_are_bounded_without_mutating_saved_history_or_other_media() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let image = Image::new(ImageFormat::Png, STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=").unwrap()).unwrap();
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
