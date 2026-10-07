use super::*;
use crate::tool::terminal::SandboxMode;

#[tokio::test]
async fn cancelled_close_releases_process_records_without_dropping_the_manager() {
    let workspace = tempfile::tempdir().unwrap();
    let policy = Policy::new(SandboxMode::Disabled, workspace.path()).unwrap();
    let manager = Manager::default();
    let session = crate::AgentSession::new();
    let ingress = Arc::new(super::super::network::IngressRuntime::default());
    let process = manager
        .spawn(
            Command {
                shell: super::super::shell::Invocation::plain(
                    Path::new("/bin/sh"),
                    "trap '' TERM; printf ready; sleep 30",
                ),
                cwd: workspace.path(),
                io: backend::IoMode::Pipe { stdin: false },
                timeout: None,
                policy: &policy,
                network_session: session.networks(),
                call_id: "lifecycle",
                observer: None,
                ingress: &ingress,
            },
            &policy,
        )
        .unwrap();
    process.state.wait(Duration::from_millis(100)).await;
    assert_eq!(process.state.take(256).output, "ready");
    let weak = Arc::downgrade(&process);
    drop(process);
    {
        let close = manager.close();
        tokio::pin!(close);
        tokio::select! {
            result = &mut close => panic!("忽略 TERM 的进程不应立即结束：{result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while weak.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("取消 close 的等待后仍必须释放终端记录及其日志");
    manager.close().await.unwrap();
}
