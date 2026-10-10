use noemori_agent::{
    CancellationToken, ExecutionContext,
    tool::ui::{
        broker::{ConnectionConfig, UiBroker},
        wire,
    },
};
use serde_json::json;
use std::{io::Cursor, sync::Arc, time::Duration};

#[test]
fn large_messages_round_trip_without_exceeding_native_frame_limits() {
    let value = json!({"data":"中文🧠".repeat(200000)});
    let mut bytes = Vec::new();
    wire::write_message(&mut bytes, &value).unwrap();
    assert_eq!(wire::read_message(&mut Cursor::new(bytes)).unwrap(), value);
}

#[test]
fn invalid_native_lengths_and_chunk_offsets_are_rejected() {
    let mut bytes = (wire::MESSAGE_LIMIT as u32 + 1).to_ne_bytes().to_vec();
    bytes.extend([0; 4]);
    assert!(wire::read_message(&mut Cursor::new(bytes)).is_err());
    let mut bytes = Vec::new();
    wire::write_message(
        &mut bytes,
        &json!({"type":"chunk","transfer":"a","offset":1,"total":4,"data":"AAAA"}),
    )
    .unwrap();
    assert!(wire::read_message(&mut Cursor::new(bytes)).is_err());
}

#[cfg(unix)]
fn connect(broker: &UiBroker, session: &str) -> std::os::unix::net::UnixStream {
    let config: ConnectionConfig =
        serde_json::from_slice(&std::fs::read(broker.configuration_path()).unwrap()).unwrap();
    let mut stream = std::os::unix::net::UnixStream::connect(config.socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    wire::write_message(&mut stream,&json!({"type":"hello","version":1,"backend":"chrome","token":config.token,"name":"测试 Chrome"})).unwrap();
    let welcome = wire::read_message(&mut stream).unwrap();
    assert_eq!(welcome["type"], "welcome");
    wire::write_message(&mut stream,&json!({"type":"share","session":session,"tabs":[{"id":"tab-one","url":"https://example.com","title":"测试"}]})).unwrap();
    stream
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn human_window_input_survives_handoff_without_granting_model_control() {
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().into(), "a".repeat(32), Arc::new(|| {})).unwrap();
    broker.register("owner", "原生窗口任务");
    let config: ConnectionConfig =
        serde_json::from_slice(&std::fs::read(broker.configuration_path()).unwrap()).unwrap();
    let mut stream = std::os::unix::net::UnixStream::connect(config.socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    wire::write_message(&mut stream, &json!({"type":"hello","version":1,"backend":"computer","token":config.token,"name":"测试应用"})).unwrap();
    assert_eq!(wire::read_message(&mut stream).unwrap()["type"], "welcome");
    let reply = std::thread::spawn(move || {
        for action in ["handoff", "human_input"] {
            let frame = wire::read_message(&mut stream).unwrap();
            assert_eq!(frame["session"], "owner");
            assert_eq!(frame["action"]["action"], action);
            if action == "human_input" {
                assert_eq!(frame["action"]["token"], "human-frame");
                assert_eq!(frame["action"]["window"], "approved-window");
            }
            wire::write_message(&mut stream, &json!({"type":"result","id":frame["id"],"value":{"outcome":"executed","mode":"human"}})).unwrap();
        }
    });
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(2)).unwrap();
    broker
        .execute("owner", "computer", json!({"action":"handoff"}), &context)
        .await
        .unwrap();
    assert!(
        broker
            .connections("owner")
            .iter()
            .any(|connection| connection.human)
    );
    assert!(broker.execute("owner", "computer", json!({"action":"pointer","app":"approved-app","window":"approved-window","x":20,"y":30}), &context).await.is_err());
    let result = broker.execute("owner", "computer", json!({"action":"human_input","app":"approved-app","window":"approved-window","token":"human-frame","input":{"type":"pointer","x":20,"y":30}}), &context).await.unwrap();
    assert_eq!(result["outcome"], "executed");
    reply.join().unwrap();
    assert!(
        serde_json::from_value::<noemori_agent::tool::ui::computer::ComputerInput>(
            json!({"action":"human_input"})
        )
        .is_err()
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn paired_requests_are_scoped_and_disconnect_does_not_keep_authority() {
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().into(), "a".repeat(32), Arc::new(|| {})).unwrap();
    broker.register("owner", "测试任务");
    let mut stream = connect(&broker, "owner");
    for _ in 0..100 {
        if broker
            .connections("owner")
            .first()
            .is_some_and(|c| !c.tabs.is_empty())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let reply = std::thread::spawn(move || {
        let frame = wire::read_message(&mut stream).unwrap();
        assert_eq!(frame["session"], "owner");
        wire::write_message(
            &mut stream,
            &json!({"type":"result","id":frame["id"],"value":{"outcome":"observed","tabs":[]}}),
        )
        .unwrap();
    });
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(2)).unwrap();
    assert_eq!(
        broker
            .execute("owner", "chrome", json!({"action":"tabs"}), &context)
            .await
            .unwrap()["outcome"],
        "observed"
    );
    reply.join().unwrap();
    for _ in 0..100 {
        if broker.connections("owner").iter().all(|c| !c.connected) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(broker.connections("owner").iter().all(|c| !c.connected));
    assert!(
        broker
            .execute("other", "chrome", json!({"action":"tabs"}), &context)
            .await
            .is_err()
    );
    broker.release("owner");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_tab_cannot_be_shared_to_two_sessions_on_one_connection() {
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().into(), "a".repeat(32), Arc::new(|| {})).unwrap();
    broker.register("one", "任务一");
    broker.register("two", "任务二");
    let mut stream = connect(&broker, "one");
    wire::write_message(
        &mut stream,
        &json!({"type":"share","session":"two","tabs":[{"id":"tab-one"}]}),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(
        broker
            .connections("two")
            .iter()
            .all(|connection| connection.tabs.is_empty() || !connection.connected)
    );
    broker.release("one");
    broker.release("two");
}

#[cfg(unix)]
#[test]
fn incorrect_token_has_no_connection_or_tab_authority() {
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().into(), "a".repeat(32), Arc::new(|| {})).unwrap();
    broker.register("owner", "任务");
    let config: ConnectionConfig =
        serde_json::from_slice(&std::fs::read(broker.configuration_path()).unwrap()).unwrap();
    let mut stream = std::os::unix::net::UnixStream::connect(config.socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    wire::write_message(
        &mut stream,
        &json!({"type":"hello","version":1,"backend":"computer","token":"wrong"}),
    )
    .unwrap();
    assert!(wire::read_message(&mut stream).is_err());
    assert!(broker.connections("owner").is_empty());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn cancellation_keeps_late_receipt_and_disconnect_settles_pending() {
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().into(), "a".repeat(32), Arc::new(|| {})).unwrap();
    broker.register("owner", "任务");
    let mut stream = connect(&broker, "owner");
    for _ in 0..100 {
        if !broker.connections("owner").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let cancellation = CancellationToken::new();
    let context = ExecutionContext::new(cancellation.clone(), Duration::from_secs(2)).unwrap();
    let task = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .execute("owner", "chrome", json!({"action":"click"}), &context)
                .await
        })
    };
    let frame = wire::read_message(&mut stream).unwrap();
    cancellation.cancel();
    assert_eq!(task.await.unwrap().unwrap_err().outcome(), "unknown");
    assert_eq!(wire::read_message(&mut stream).unwrap()["type"], "cancel");
    wire::write_message(
        &mut stream,
        &json!({"type":"result","id":frame["id"],"value":{"outcome":"executed"}}),
    )
    .unwrap();
    for _ in 0..100 {
        if broker.receipts("owner").first().is_some_and(|r| !r.pending) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(broker.receipts("owner")[0].outcome, "executed");
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(2)).unwrap();
    let task = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .execute("owner", "chrome", json!({"action":"click"}), &context)
                .await
        })
    };
    let _ = wire::read_message(&mut stream).unwrap();
    drop(stream);
    assert_eq!(task.await.unwrap().unwrap_err().outcome(), "unknown");
    assert!(!broker.receipts("owner").last().unwrap().pending);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn reused_broker_notifies_each_host_observer() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = tempfile::tempdir().unwrap();
    let first = Arc::new(AtomicUsize::new(0));
    let second = Arc::new(AtomicUsize::new(0));
    let observer = |counter: Arc<AtomicUsize>| {
        Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }) as Arc<dyn Fn() + Send + Sync>
    };
    let broker =
        UiBroker::open(root.path().into(), "a".repeat(32), observer(first.clone())).unwrap();
    let _other =
        UiBroker::open(root.path().into(), "a".repeat(32), observer(second.clone())).unwrap();
    broker.register("owner", "任务");
    let _stream = connect(&broker, "owner");
    for _ in 0..100 {
        if second.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(first.load(Ordering::SeqCst) > 0);
    assert!(second.load(Ordering::SeqCst) > 0);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn closing_revokes_dispatch_before_the_release_acknowledgement() {
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().into(), "a".repeat(32), Arc::new(|| {})).unwrap();
    broker.register("owner", "任务");
    let mut stream = connect(&broker, "owner");
    wire::write_message(&mut stream, &json!({"type":"sessions"})).unwrap();
    assert_eq!(wire::read_message(&mut stream).unwrap()["type"], "sessions");
    let closing = {
        let broker = broker.clone();
        tokio::spawn(async move { broker.release_confirmed("owner").await })
    };
    let release = wire::read_message(&mut stream).unwrap();
    assert_eq!(release["type"], "release");
    let context =
        ExecutionContext::new(CancellationToken::new(), Duration::from_millis(50)).unwrap();
    let result = broker
        .execute("owner", "chrome", json!({"action":"click"}), &context)
        .await;
    wire::write_message(
        &mut stream,
        &json!({"type":"result","id":release["id"],"value":{"outcome":"executed"}}),
    )
    .unwrap();
    closing.await.unwrap().unwrap();
    assert_eq!(result.unwrap_err().outcome(), "not_executed");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_close_wait_does_not_abandon_resource_cleanup() {
    use noemori_agent::{
        AgentSession,
        tool::{
            Tool, ToolContext,
            ui::{
                UiConfig, UiInput, UiTool,
                computer::{UiAccessDecision, UiAccessRequest, UiApprover},
            },
        },
    };
    struct Deny;
    #[async_trait::async_trait]
    impl UiApprover for Deny {
        async fn approve(
            &self,
            _: UiAccessRequest,
            _: ExecutionContext,
        ) -> Result<UiAccessDecision, String> {
            Ok(UiAccessDecision::Deny("测试没有前台授权".into()))
        }
    }
    let root = tempfile::tempdir().unwrap();
    let broker =
        UiBroker::open(root.path().join("private"), "a".repeat(32), Arc::new(|| {})).unwrap();
    let executable = env!("CARGO_BIN_EXE_noemori-ui-runtime").into();
    let tool = UiTool::new(executable, None)
        .unwrap()
        .with_connections(
            UiConfig {
                executable: env!("CARGO_BIN_EXE_noemori-ui-runtime").into(),
                broker: broker.clone(),
                computer_helper: None,
                workspace: root.path().into(),
            },
            Arc::new(Deny),
        )
        .unwrap();
    let session = AgentSession::new();
    let id = session.id().to_owned();
    tool.execute(
        UiInput::Run {
            code: "print(1)".into(),
            timeout_ms: 2000,
        },
        ToolContext {
            call_id: "bind".into(),
            session: session.clone(),
            execution: ExecutionContext::new(CancellationToken::new(), Duration::from_secs(3))
                .unwrap(),
        },
    )
    .await
    .unwrap();
    let mut stream = connect(&broker, &id);
    wire::write_message(&mut stream, &json!({"type":"sessions"})).unwrap();
    let _ = wire::read_message(&mut stream).unwrap();
    let closing = {
        let session = session.clone();
        tokio::spawn(async move { session.close().await })
    };
    let release = wire::read_message(&mut stream).unwrap();
    assert_eq!(release["type"], "release");
    closing.abort();
    assert!(closing.await.unwrap_err().is_cancelled());
    wire::write_message(
        &mut stream,
        &json!({"type":"result","id":release["id"],"value":{"outcome":"executed"}}),
    )
    .unwrap();
    session.close().await.unwrap();
    wire::write_message(&mut stream, &json!({"type":"sessions"})).unwrap();
    let available = loop {
        let value = wire::read_message(&mut stream).unwrap();
        if value["type"] == "sessions" {
            break value;
        }
    };
    assert!(
        available["sessions"].get(&id).is_none(),
        "关闭的会话不能继续被共享"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn malformed_outcome_is_retained_as_unknown_instead_of_breaking_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().into(), "a".repeat(32), Arc::new(|| {})).unwrap();
    broker.register("owner", "任务");
    let mut stream = connect(&broker, "owner");
    wire::write_message(&mut stream, &json!({"type":"sessions"})).unwrap();
    let _ = wire::read_message(&mut stream).unwrap();
    let reply = std::thread::spawn(move || {
        let request = wire::read_message(&mut stream).unwrap();
        wire::write_message(
            &mut stream,
            &json!({"type":"result","id":request["id"],"value":{"outcome":"success"}}),
        )
        .unwrap();
    });
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(2)).unwrap();
    let result = broker
        .execute("owner", "chrome", json!({"action":"click"}), &context)
        .await
        .unwrap();
    reply.join().unwrap();
    assert_eq!(result["outcome"], "unknown");
    assert!(result["error"].as_str().is_some());
    assert_eq!(
        serde_json::to_value(broker.receipts("owner")).unwrap()[0]["outcome"],
        "unknown"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn downloads_commit_only_complete_bytes_and_release_removes_files() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().into(), "a".repeat(32), Arc::new(|| {})).unwrap();
    broker.register("owner", "任务");
    let mut stream = connect(&broker, "owner");
    let id = uuid::Uuid::new_v4().to_string();
    let artifact = json!({"type":"artifact","id":id,"session":"owner","page":"tab-one","name":"报告.txt","data":STANDARD.encode("原始完整内容")});
    wire::write_message(&mut stream, &artifact).unwrap();
    let saved = wire::read_message(&mut stream).unwrap();
    assert_eq!(saved["type"], "artifact_saved");
    assert!(saved["error"].is_null());
    assert_eq!(
        broker.downloads("owner", "chrome")[0]["bytes"],
        "原始完整内容".len()
    );
    assert!(broker.downloads("other", "chrome").is_empty());
    wire::write_message(&mut stream, &artifact).unwrap();
    assert!(
        wire::read_message(&mut stream).unwrap()["error"]
            .as_str()
            .is_some()
    );
    assert_eq!(
        std::fs::read_dir(root.path().join("downloads"))
            .unwrap()
            .count(),
        1
    );
    let reply = std::thread::spawn(move || {
        let release = wire::read_message(&mut stream).unwrap();
        wire::write_message(
            &mut stream,
            &json!({"type":"result","id":release["id"],"value":{"outcome":"executed"}}),
        )
        .unwrap();
    });
    broker.release_confirmed("owner").await.unwrap();
    reply.join().unwrap();
    assert_eq!(
        std::fs::read_dir(root.path().join("downloads"))
            .unwrap()
            .count(),
        0
    );
}
