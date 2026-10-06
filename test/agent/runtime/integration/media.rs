use super::*;
use noemori_agent::{
    Audio, AudioFormat, ContentPart, Image, ImageFormat, Media, MediaSource, Video, VideoFormat,
};

struct MediaModel {
    inner: ScriptedModel,
    audio: bool,
}
impl Model for MediaModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tools: true,
            streaming: true,
            vision: true,
            audio: self.audio,
            video: true,
        }
    }
    fn generate(&self, request: ModelRequest, context: ExecutionContext) -> ModelStream {
        self.inner.generate(request, context)
    }
}

#[derive(Deserialize, JsonSchema)]
struct EmptyArgs {}
struct ReadMedia(Vec<Media>);
#[async_trait]
impl Tool for ReadMedia {
    type Args = EmptyArgs;
    type Output = serde_json::Value;
    fn name(&self) -> &str {
        "read_media"
    }
    fn description(&self) -> &str {
        "返回有序媒体附件"
    }
    fn media(&self, _: &Self::Output) -> Vec<Media> {
        self.0.clone()
    }
    async fn execute(&self, _: Self::Args, _: ToolContext) -> Result<Self::Output, ToolError> {
        Ok(json!({"pages":1,"duration":2}))
    }
}
fn attachments() -> Vec<Media> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let image = Image::new(ImageFormat::Png, STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=").unwrap()).unwrap();
    vec![
        Media::Audio(
            Audio::new(AudioFormat::Wav, MediaSource::bytes(vec![1, 2, 3]).unwrap()).unwrap(),
        ),
        Media::Image(image),
        Media::Video(
            Video::new(
                VideoFormat::Mp4,
                MediaSource::Url("https://example.com/video".into()),
            )
            .unwrap(),
        ),
    ]
}
fn registry(media: Vec<Media>) -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    tools.register(ReadMedia(media)).unwrap();
    tools
}
fn model(audio: bool) -> Arc<MediaModel> {
    Arc::new(MediaModel {
        inner: ScriptedModel::new(vec![
            vec![calls(&[("a", "read_media", json!({}))])],
            vec![answer("done")],
        ]),
        audio,
    })
}

#[tokio::test]
async fn ordered_tool_media_survive_commit_and_history_reload_into_the_next_turn() {
    let model = model(true);
    let report = agent(model.clone(), registry(attachments()), 3)
        .run(input())
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    let requests = model.inner.requests.lock().unwrap();
    let ContentPart::ToolResult(result) = &requests[1].messages[2].content[0] else {
        panic!()
    };
    assert_eq!(result.media, attachments());
    assert_eq!(result.call_id, "a");
    assert_eq!(result.output, json!({"pages":1,"duration":2}));
    let saved = serde_json::to_vec(&report.history).unwrap();
    let history: Vec<Message> = serde_json::from_slice(&saved).unwrap();
    validate_history(&history).unwrap();
    assert_eq!(history, report.history);
}

#[tokio::test]
async fn invalid_tool_media_become_clear_error_observations_and_the_agent_can_continue() {
    let invalid: Audio =
        serde_json::from_value(json!({"format":"wav","source":{"type":"bytes","value":[]}}))
            .unwrap();
    let model = model(true);
    let report = agent(model.clone(), registry(vec![Media::Audio(invalid)]), 3)
        .run(input())
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    let requests = model.inner.requests.lock().unwrap();
    let ContentPart::ToolResult(result) = &requests[1].messages[2].content[0] else {
        panic!()
    };
    assert!(result.is_error);
    assert!(result.media.is_empty());
    assert!(result.output["error"].as_str().unwrap().contains("非空"));
}

#[tokio::test]
async fn unsupported_tool_media_fail_explicitly_without_discarding_committed_attachments() {
    let model = model(false);
    let report = agent(model.clone(), registry(attachments()), 3)
        .run(input())
        .await
        .unwrap();
    assert!(
        matches!(&report.status, RunStatus::Failed(Error::Unsupported(reason)) if reason.contains("音频"))
    );
    assert_eq!(model.inner.requests.lock().unwrap().len(), 1);
    let ContentPart::ToolResult(result) = &report.history[2].content[0] else {
        panic!()
    };
    assert_eq!(result.media, attachments());
    validate_history(&report.history).unwrap();
}
