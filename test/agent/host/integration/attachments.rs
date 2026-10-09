use super::{model, wait};
use noemori_agent::{
    ContentPart, Error, ExecutionContext, Image, ImageFormat,
    host::{DesktopSession, DesktopSessionOptions, HostRunStatus},
    llm::{Capabilities, Model, ModelRequest, ModelStream},
};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

fn image() -> Image {
    use base64::{Engine, engine::general_purpose::STANDARD};
    Image::new(ImageFormat::Png, STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==").unwrap()).unwrap()
}

struct VisionModel {
    vision: bool,
    requests: Mutex<Vec<ModelRequest>>,
    gate: Option<Arc<Notify>>,
    max_images: Option<usize>,
}
impl Model for VisionModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            vision: self.vision,
            ..Default::default()
        }
    }
    fn validate_request(&self, request: &ModelRequest) -> Result<(), Error> {
        request.validate(self.capabilities())?;
        let images = request
            .messages
            .iter()
            .flat_map(|message| &message.content)
            .filter(|part| matches!(part, ContentPart::Image(_)))
            .count();
        if self.max_images.is_some_and(|limit| images > limit) {
            return Err(Error::Config("图片请求预算不足".into()));
        }
        Ok(())
    }
    fn generate(&self, request: ModelRequest, _: ExecutionContext) -> ModelStream {
        let first = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request);
            requests.len() == 1
        };
        let gate = self.gate.clone().filter(|_| first);
        Box::pin(
            async_stream::stream! { if let Some(gate) = gate { gate.notified().await; } yield model::answer("已读取"); },
        )
    }
}
fn model(vision: bool, gate: Option<Arc<Notify>>) -> Arc<VisionModel> {
    Arc::new(VisionModel {
        vision,
        gate,
        requests: Mutex::new(Vec::new()),
        max_images: None,
    })
}

#[tokio::test]
async fn images_enter_native_model_content_and_restore_without_reloading_user_files() {
    let root = tempfile::tempdir().unwrap();
    let model = model(true, None);
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start_configured_with_images(
        model.clone(),
        "vision".into(),
        "分析附件".into(),
        Some("文章上下文".into()),
        vec![image()],
    )
    .unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    let saved = host.checkpoint().unwrap();
    host.close().await.unwrap();
    let restored = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    restored.restore(saved).unwrap();
    restored.start("继续分析".into()).unwrap();
    wait(&restored, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.requests.lock().unwrap();
        for request in requests.iter() {
            assert_eq!(
                request
                    .messages
                    .iter()
                    .flat_map(|message| &message.content)
                    .filter(|part| matches!(part, ContentPart::Image(_)))
                    .count(),
                1
            );
            assert!(
                request
                    .messages
                    .iter()
                    .any(|message| message.text_content() == "文章上下文")
            );
        }
    }
    restored.close().await.unwrap();
}

#[tokio::test]
async fn unsupported_images_are_rejected_before_mutating_history() {
    let root = tempfile::tempdir().unwrap();
    let model = model(false, None);
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    assert!(matches!(
        host.start_configured_with_images(
            model.clone(),
            "text".into(),
            "分析附件".into(),
            None,
            vec![image()]
        ),
        Err(Error::Unsupported(_))
    ));
    assert!(host.snapshot().messages.is_empty());
    assert!(host.snapshot().run.is_none());
    assert!(model.requests.lock().unwrap().is_empty());
    host.close().await.unwrap();
}

#[tokio::test]
async fn image_steering_stays_in_the_current_run_and_only_appears_in_the_next_request() {
    let root = tempfile::tempdir().unwrap();
    let gate = Arc::new(Notify::new());
    let model = model(true, Some(gate.clone()));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("开始任务".into()).unwrap();
    wait(&host, |_| model.requests.lock().unwrap().len() == 1).await;
    assert_eq!(
        host.steer_with_images(&run, "补充图片".into(), vec![image()], false)
            .unwrap(),
        run
    );
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    gate.notify_one();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(host.snapshot().turns.len(), 1);
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[1]
                .messages
                .iter()
                .flat_map(|message| &message.content)
                .any(|part| matches!(part, ContentPart::Image(_)))
        );
    }
    host.close().await.unwrap();
}

#[tokio::test]
async fn media_budget_is_checked_before_accepting_start_or_multiple_pending_inputs() {
    let root = tempfile::tempdir().unwrap();
    let gate = Arc::new(Notify::new());
    let model = Arc::new(VisionModel {
        vision: true,
        gate: Some(gate.clone()),
        requests: Mutex::new(Vec::new()),
        max_images: Some(1),
    });
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    assert!(matches!(
        host.start_configured_with_images(
            model.clone(),
            "vision".into(),
            "过大".into(),
            None,
            vec![image(), image()]
        ),
        Err(Error::Config(_))
    ));
    assert!(host.snapshot().messages.is_empty());
    let run = host.start("任务".into()).unwrap();
    wait(&host, |_| model.requests.lock().unwrap().len() == 1).await;
    host.steer_with_images(&run, "第一个图片".into(), vec![image()], false)
        .unwrap();
    let saved = host.checkpoint().unwrap();
    assert!(matches!(
        host.steer_with_images(&run, "超额图片".into(), vec![image()], false),
        Err(Error::Config(_))
    ));
    assert_eq!(
        host.snapshot()
            .messages
            .iter()
            .filter(|message| message.role == noemori_agent::Role::User)
            .count(),
        2
    );
    assert_eq!(
        serde_json::to_value(host.checkpoint().unwrap()).unwrap()["history"],
        serde_json::to_value(saved).unwrap()["history"]
    );
    gate.notify_one();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    host.close().await.unwrap();
}

#[tokio::test]
async fn http_json_body_budget_rejects_media_before_the_host_mutates_history() {
    use noemori_agent::llm::{HttpModel, ModelConfig, Protocol};
    let root = tempfile::tempdir().unwrap();
    let mut config = ModelConfig::new(Protocol::OpenAiChat, "fixture", "http://127.0.0.1:1/chat");
    config.capabilities.vision = true;
    config.max_request_bytes = 128;
    let model = Arc::new(HttpModel::new(config).unwrap());
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    assert!(matches!(
        host.start_configured_with_images(
            model,
            "vision".into(),
            "图片".into(),
            None,
            vec![image()]
        ),
        Err(Error::Config(_))
    ));
    assert!(host.snapshot().messages.is_empty());
    assert!(host.snapshot().run.is_none());
    host.close().await.unwrap();
}
