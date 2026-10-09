use super::{model, wait};
use noemori_agent::{
    ExecutionContext, Role,
    host::{DesktopSession, DesktopSessionOptions, HostRunStatus},
    llm::{Capabilities, Model, ModelRequest, ModelStream},
};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

struct GatedModel {
    requests: Mutex<Vec<ModelRequest>>,
    release: Arc<Notify>,
}

impl GatedModel {
    fn new() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            release: Arc::new(Notify::new()),
        }
    }
}

impl Model for GatedModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tools: true,
            ..Default::default()
        }
    }
    fn generate(&self, request: ModelRequest, _: ExecutionContext) -> ModelStream {
        let first = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request);
            requests.len() == 1
        };
        let release = self.release.clone();
        Box::pin(async_stream::stream! {
            if first { release.notified().await; }
            yield model::answer(if first { "原请求完成" } else { "已处理补充指令" });
        })
    }
}

#[tokio::test]
async fn steering_stays_in_the_active_turn_and_rejects_stale_or_settled_runs() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(GatedModel::new());
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("先整理项目".into()).unwrap();
    wait(&host, |_| model.requests.lock().unwrap().len() == 1).await;
    assert!(host.steer("stale", "不能进入历史".into()).is_err());
    assert_eq!(
        host.steer(&run, "先修复测试，再整理项目".into()).unwrap(),
        run
    );
    assert_eq!(host.snapshot().turns.len(), 1);
    model.release.notify_one();
    let finished = wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(finished.run.as_ref().unwrap().id, run);
    assert_eq!(finished.run.as_ref().unwrap().model_calls, 2);
    assert_eq!(finished.turns.len(), 1);
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].messages.last().unwrap().role, Role::User);
    assert_eq!(
        requests[1].messages.last().unwrap().text_content(),
        "先修复测试，再整理项目"
    );
    noemori_agent::validate_history(&requests[1].messages).unwrap();
    drop(requests);
    assert!(host.steer(&run, "不能进入已结束轮次".into()).is_err());
    host.close().await.unwrap();
}

#[tokio::test]
async fn accepted_steering_survives_cancellation_before_the_next_model_call() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(GatedModel::new());
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("开始检查".into()).unwrap();
    wait(&host, |_| model.requests.lock().unwrap().len() == 1).await;
    host.steer(&run, "保留这条补充指令".into()).unwrap();
    host.interrupt(&run).await.unwrap();
    host.start("继续任务".into()).unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    let requests = model.requests.lock().unwrap();
    let history = &requests[1].messages;
    assert_eq!(
        history
            .iter()
            .filter(|message| message.role == Role::User
                && message.text_content() == "保留这条补充指令")
            .count(),
        1
    );
    noemori_agent::validate_history(history).unwrap();
    drop(requests);
    host.close().await.unwrap();
}
