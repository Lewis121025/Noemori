use super::*;
use noemori_agent::{
    ExecutionContext,
    llm::{Capabilities, Model, ModelRequest, ModelStream},
};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

/// 首轮受测试通知控制，确保接管发生在模型请求中而不是已经完成的任务之后。
struct PausableModel {
    started: Notify,
    release: Arc<Notify>,
    calls: AtomicUsize,
}
impl Model for PausableModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }
    fn generate(&self, _request: ModelRequest, context: ExecutionContext) -> ModelStream {
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        self.started.notify_one();
        let release = self.release.clone();
        Box::pin(async_stream::try_stream! {
            if first { context.wait(release.notified()).await?; }
            yield model::answer(if first { "操作前的观察" } else { "已继续原任务" })?;
        })
    }
}

/// 429 的重试等待没有外部动作，接管必须能立即中断等待而不结束任务。
struct RetryingModel {
    started: Notify,
    calls: AtomicUsize,
}
impl Model for RetryingModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }
    fn generate(&self, _request: ModelRequest, _context: ExecutionContext) -> ModelStream {
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        self.started.notify_one();
        Box::pin(async_stream::try_stream! {
            if first { Err(noemori_agent::Error::Http { status: 429, message: "等待重试".into(), retry_after: Some(Duration::from_secs(120)) })?; }
            yield model::answer("重试后完成")?;
        })
    }
}

#[tokio::test(start_paused = true)]
async fn takeover_interrupts_retry_wait_and_resumes_the_same_task() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(RetryingModel {
        started: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("等待中的任务".into()).unwrap();
    model.started.notified().await;
    tokio::task::yield_now().await;
    let paused = tokio::time::timeout(Duration::from_secs(1), host.pause()).await;
    let snapshot = host.snapshot();
    if paused.as_ref().is_ok_and(|result| result.is_ok()) {
        assert_eq!(host.resume(&run).unwrap(), run);
        tokio::task::yield_now().await;
        assert_eq!(
            model.calls.load(Ordering::SeqCst),
            1,
            "交还不能绕过服务商的重试时间"
        );
        tokio::time::advance(Duration::from_secs(120)).await;
        wait(&host, |view| {
            view.run
                .as_ref()
                .is_some_and(|run| run.status == HostRunStatus::Completed)
        })
        .await;
    }
    host.close().await.unwrap();
    assert!(
        paused.is_ok_and(|result| result.is_ok()),
        "429 的等待不能阻塞接管"
    );
    assert_eq!(snapshot.run.unwrap().status, HostRunStatus::Paused);
}

#[tokio::test]
async fn taking_control_pauses_the_same_task_and_resumes_without_another_user_message() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(PausableModel {
        started: Notify::new(),
        release: Arc::new(Notify::new()),
        calls: AtomicUsize::new(0),
    });
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("检查页面".into()).unwrap();
    model.started.notified().await;
    let pausing = tokio::spawn({
        let host = host.clone();
        async move { host.pause().await }
    });
    tokio::task::yield_now().await;
    model.release.notify_one();
    pausing.await.unwrap().unwrap();
    let snapshot = host.snapshot();
    assert_eq!(snapshot.run.as_ref().unwrap().id, run);
    assert_eq!(snapshot.run.as_ref().unwrap().status, HostRunStatus::Paused);
    assert_eq!(
        snapshot.turns.last().unwrap().run.status,
        snapshot.run.as_ref().unwrap().status,
        "末轮与当前运行必须交付同一暂停状态"
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(host.resume(&run).unwrap(), run);
    let finished = wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(finished.run.as_ref().unwrap().id, run);
    assert_eq!(
        finished
            .messages
            .iter()
            .filter(|message| message.role == noemori_agent::Role::User)
            .count(),
        1
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    host.close().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn waiting_for_the_user_does_not_spend_the_task_timeout() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(PausableModel {
        started: Notify::new(),
        release: Arc::new(Notify::new()),
        calls: AtomicUsize::new(0),
    });
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("检查页面".into()).unwrap();
    model.started.notified().await;
    host.pause().await.unwrap();
    tokio::time::advance(Duration::from_secs(3600)).await;
    assert_eq!(host.snapshot().run.unwrap().status, HostRunStatus::Paused);
    host.resume(&run).unwrap();
    wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    host.close().await.unwrap();
}

#[tokio::test]
async fn closing_a_paused_task_cancels_it_without_resuming_the_model() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(PausableModel {
        started: Notify::new(),
        release: Arc::new(Notify::new()),
        calls: AtomicUsize::new(0),
    });
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start("检查页面".into()).unwrap();
    model.started.notified().await;
    host.pause().await.unwrap();
    host.close().await.unwrap();
    assert_eq!(
        host.snapshot().run.unwrap().status,
        HostRunStatus::Cancelled
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
}
