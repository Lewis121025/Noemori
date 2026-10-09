use super::{model, wait};
use noemori_agent::{
    Error, ExecutionContext, Role,
    host::{DesktopSession, DesktopSessionOptions, HostRunStatus},
    llm::{Capabilities, Model, ModelEvent, ModelRequest, ModelStream},
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn manual_continuation_retains_context_and_partial_text_without_replaying_a_tool() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[(
            "write-once",
            "terminal",
            json!({"action":"exec","cmd":"printf tick >> actions.txt","yield_time_ms":5000}),
        )])],
        vec![
            Ok(ModelEvent::TextDelta("尚未完成的说明".into())),
            Err(Error::Protocol("连接中断".into())),
        ],
        vec![model::answer("已继续")],
    ]));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start_with_context("处理文章".into(), "旧版本文章位置".into())
        .unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Failed)
    })
    .await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("actions.txt")).unwrap(),
        "tick"
    );
    host.start_with_context("继续任务".into(), "新版本文章位置".into())
        .unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        let history = &requests[2].messages;
        noemori_agent::validate_history(history).unwrap();
        for context in ["旧版本文章位置", "新版本文章位置"] {
            assert_eq!(
                history
                    .iter()
                    .filter(
                        |message| message.role == Role::User && message.text_content() == context
                    )
                    .count(),
                1
            );
        }
        assert_eq!(
            serde_json::to_string(history)
                .unwrap()
                .matches("尚未完成的说明")
                .count(),
            1
        );
        assert_eq!(
            history
                .iter()
                .flat_map(|message| message.tool_calls())
                .count(),
            1
        );
    }
    assert_eq!(
        std::fs::read_to_string(root.path().join("actions.txt")).unwrap(),
        "tick"
    );
    host.close().await.unwrap();
}

struct PanickingModel(AtomicUsize);
impl Model for PanickingModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }
    fn generate(&self, _: ModelRequest, _: ExecutionContext) -> ModelStream {
        let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async_stream::stream! {
            assert!(!first, "可控的模型任务异常");
            yield model::answer("异常后可重新运行");
        })
    }
}

#[tokio::test]
async fn a_panicking_model_task_settles_the_run_and_releases_its_ownership() {
    let root = tempfile::tempdir().unwrap();
    let host = DesktopSession::new(
        Arc::new(PanickingModel(AtomicUsize::new(0))),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let failed = host.start("启动异常任务".into()).unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Failed)
    })
    .await;
    host.interrupt(&failed).await.unwrap();
    host.checkpoint().unwrap();
    let next = host.start("重新检查".into()).unwrap();
    assert_ne!(next, failed);
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    host.close().await.unwrap();
    assert!(host.snapshot().closed);
}
