use super::{call, output};
use base64::{Engine, engine::general_purpose::STANDARD};
use noemori_agent::{
    AgentSession,
    tool::{
        ToolRegistry,
        terminal::{
            SandboxMode, TerminalEvent, TerminalInfo, TerminalLogLimits, TerminalObserver,
            TerminalStream, TerminalSubscription, TerminalTool,
        },
    },
};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;

fn setup() -> (TerminalTool, ToolRegistry) {
    let tool =
        TerminalTool::configured(std::env::temp_dir(), "/bin/sh", SandboxMode::Disabled).unwrap();
    let mut tools = ToolRegistry::new();
    tools.register(tool.clone()).unwrap();
    (tool, tools)
}

#[tokio::test]
async fn final_status_survives_log_release_even_if_the_subscriber_was_never_polled() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"sleep 30","yield_time_ms":0}),
    )
    .await;
    let mut subscription = tool
        .subscribe(&session, first["session_id"].as_str().unwrap(), 0)
        .unwrap();
    assert!(subscription.final_info().is_none());
    session.close().await.unwrap();
    assert_ne!(
        subscription.final_info().unwrap().status,
        noemori_agent::tool::terminal::TerminalStatus::Running
    );
    assert!(subscription.recv().await.is_err());
}

struct Observer(mpsc::UnboundedSender<(String, TerminalInfo, TerminalSubscription)>);
impl TerminalObserver for Observer {
    fn started(&self, call_id: &str, process: TerminalInfo, output: TerminalSubscription) {
        self.0.send((call_id.into(), process, output)).unwrap();
    }
}

async fn collect(subscription: &mut TerminalSubscription) -> (Vec<u8>, Vec<u8>, TerminalInfo) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        match subscription.recv().await.unwrap().unwrap() {
            TerminalEvent::Output { chunk, .. } => {
                let bytes = STANDARD.decode(chunk.data_base64).unwrap();
                match chunk.stream {
                    TerminalStream::Stdout | TerminalStream::Terminal => stdout.extend(bytes),
                    TerminalStream::Stderr => stderr.extend(bytes),
                }
            }
            TerminalEvent::Exited { process } => {
                assert!(subscription.recv().await.unwrap().is_none());
                return (stdout, stderr, process);
            }
        }
    }
}

#[tokio::test]
async fn host_input_can_reach_a_waiting_exec_without_consuming_model_output() {
    let (sender, mut starts) = mpsc::unbounded_channel();
    let (tool, _) = setup();
    let tool = tool.with_observer(Arc::new(Observer(sender)));
    let mut tools = ToolRegistry::new();
    tools.register(tool.clone()).unwrap();
    let session = AgentSession::new();
    let returned = AtomicBool::new(false);
    let execute = async {
        let result = output(
            &tools,
            &session,
            json!({
                "action":"exec", "stdin":true, "yield_time_ms":10000,
                "cmd":"printf ready; read value; printf 'received:%s\\n' \"$value\""
            }),
        )
        .await;
        returned.store(true, Ordering::SeqCst);
        result
    };
    let host = async {
        let (_, info, mut subscription) = starts.recv().await.unwrap();
        let event = subscription.recv().await.unwrap().unwrap();
        let TerminalEvent::Output { chunk, .. } = event else {
            panic!("必须先收到提示")
        };
        assert_eq!(STANDARD.decode(chunk.data_base64).unwrap(), b"ready");
        assert!(!returned.load(Ordering::SeqCst));
        tool.send_input(
            &session,
            &info.session_id,
            b"line\n",
            true,
            noemori_agent::ExecutionContext::new(
                noemori_agent::CancellationToken::new(),
                Duration::from_secs(2),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        collect(&mut subscription).await
    };
    let (result, (stdout, stderr, exit)) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(execute, host)
    })
    .await
    .unwrap();
    assert_eq!(stdout, b"received:line\n");
    assert!(stderr.is_empty());
    assert_eq!(exit.exit_code, Some(0));
    assert_eq!(result["output"], "readyreceived:line\n");
    session.close().await.unwrap();
}

#[tokio::test]
async fn host_input_checks_ownership_budget_and_cancellation_before_writing_or_closing() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "stdin":true, "yield_time_ms":0, "cmd":"cat"}),
    )
    .await;
    let id = first["session_id"].as_str().unwrap();
    let context = || {
        noemori_agent::ExecutionContext::new(
            noemori_agent::CancellationToken::new(),
            Duration::from_secs(2),
        )
        .unwrap()
    };
    let foreign = AgentSession::new();
    assert!(
        tool.send_input(&foreign, id, b"foreign", true, context())
            .await
            .is_err()
    );
    let different =
        TerminalTool::configured(std::env::temp_dir(), "/bin/sh", SandboxMode::default()).unwrap();
    assert!(
        different
            .send_input(&session, id, b"different", true, context())
            .await
            .is_err()
    );
    assert!(
        tool.send_input(&session, id, &vec![b'x'; 16385], true, context())
            .await
            .is_err()
    );
    let cancelled = context();
    cancelled.cancellation.cancel();
    assert!(matches!(
        tool.send_input(&session, id, b"cancelled", true, cancelled)
            .await,
        Err(noemori_agent::Error::Cancelled)
    ));
    tool.send_input(&session, id, &[0, 255, 3], true, context())
        .await
        .unwrap();
    let mut subscription = tool.subscribe(&session, id, 0).unwrap();
    let (bytes, errors, exit) = collect(&mut subscription).await;
    assert_eq!(bytes, [0, 255, 3]);
    assert!(errors.is_empty());
    assert_eq!(exit.exit_code, Some(0));
    let model = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":id,"yield_time_ms":0}),
    )
    .await;
    assert!(!model["output"].as_str().unwrap().is_empty());
    foreign.close().await.unwrap();
    session.close().await.unwrap();
}

#[tokio::test]
async fn host_stop_is_immediate_and_preserves_pending_model_output() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf marker; sleep 30","yield_time_ms":0}),
    )
    .await;
    let id = first["session_id"].as_str().unwrap();
    let mut subscription = tool.subscribe(&session, id, 0).unwrap();
    let event = subscription.recv().await.unwrap().unwrap();
    let TerminalEvent::Output { chunk, .. } = event else {
        panic!("必须先收到输出")
    };
    assert_eq!(STANDARD.decode(chunk.data_base64).unwrap(), b"marker");
    let foreign = AgentSession::new();
    assert!(tool.request_stop(&foreign, id).is_err());
    let requested = tool.request_stop(&session, id).unwrap();
    assert_eq!(requested.session_id, id);
    assert_eq!(
        requested.status,
        noemori_agent::tool::terminal::TerminalStatus::Running
    );
    let (_, _, ended) = tokio::time::timeout(Duration::from_secs(3), collect(&mut subscription))
        .await
        .unwrap();
    assert_ne!(
        ended.status,
        noemori_agent::tool::terminal::TerminalStatus::Running
    );
    let model = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":id,"yield_time_ms":0}),
    )
    .await;
    assert_eq!(
        format!(
            "{}{}",
            first["output"].as_str().unwrap(),
            model["output"].as_str().unwrap()
        ),
        "marker"
    );
    tool.request_stop(&session, id).unwrap();
    foreign.close().await.unwrap();
    session.close().await.unwrap();
}

#[tokio::test]
async fn observer_receives_output_before_exec_returns_and_exit_follows_all_bytes() {
    let workspace = tempfile::tempdir().unwrap();
    let (sender, mut starts) = mpsc::unbounded_channel();
    let (tool, _) = setup();
    let mut tools = ToolRegistry::new();
    tools
        .register(tool.with_observer(Arc::new(Observer(sender))))
        .unwrap();
    let session = AgentSession::new();
    let returned = AtomicBool::new(false);
    let execute = async {
        let result = output(&tools, &session, json!({
            "action":"exec", "workdir":workspace.path(), "yield_time_ms":10000,
            "cmd":"printf early; while ! test -f finish; do sleep 0.01; done; printf '\\377late'; printf error >&2; exit 9"
        })).await;
        returned.store(true, Ordering::SeqCst);
        result
    };
    let observe = async {
        let (call_id, info, mut subscription) = starts.recv().await.unwrap();
        assert_eq!(call_id, "test");
        let event = tokio::time::timeout(Duration::from_secs(2), subscription.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            !returned.load(Ordering::SeqCst),
            "宿主必须在 exec 仍等待时就接到输出"
        );
        let TerminalEvent::Output { session_id, chunk } = event else {
            panic!("必须先收到输出")
        };
        assert_eq!(session_id, info.session_id);
        assert_eq!(chunk.stream, TerminalStream::Stdout);
        assert_eq!(STANDARD.decode(chunk.data_base64).unwrap(), b"early");
        std::fs::write(workspace.path().join("finish"), "ready").unwrap();
        collect(&mut subscription).await
    };
    let (result, (stdout, stderr, exit)) = tokio::join!(execute, observe);
    assert_eq!(stdout, b"\xfflate");
    assert_eq!(stderr, b"error");
    assert_eq!(exit.exit_code, Some(9));
    assert_eq!(result["exit_code"], 9);
    session.close().await.unwrap();
}

#[tokio::test]
async fn slow_subscribers_replay_all_output_without_consuming_each_other_or_text() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec", "cmd":"head -c 100000 /dev/zero | tr '\\000' x; printf err >&2", "yield_time_ms":0, "max_output_chars":120000})).await;
    let id = first["session_id"].as_str().unwrap();
    let mut fast = tool.subscribe(&session, id, 0).unwrap();
    let mut slow = tool.subscribe(&session, id, 0).unwrap();
    let (stdout, stderr, exit) = collect(&mut fast).await;
    assert_eq!(stdout, vec![b'x'; 100000]);
    assert_eq!(stderr, b"err");
    assert_eq!(exit.exit_code, Some(0));
    let (replayed, errors, _) = collect(&mut slow).await;
    assert_eq!(replayed, stdout);
    assert_eq!(errors, stderr);
    assert_eq!(fast.next_offset(), 100003);
    assert_eq!(slow.next_offset(), fast.next_offset());
    let text = output(
        &tools,
        &session,
        json!({"action":"interact", "session_id":id, "yield_time_ms":0, "max_output_chars":120000}),
    )
    .await;
    let visible = format!(
        "{}{}",
        first["output"].as_str().unwrap(),
        text["output"].as_str().unwrap()
    );
    assert!(visible.contains("err"));
    assert_eq!(
        text["output"].as_str().unwrap().len() + first["output"].as_str().unwrap().len(),
        100003
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn pty_output_is_tagged_as_terminal_and_keeps_ansi_sequences_and_raw_bytes() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec", "cmd":"printf '\\033[31m\\377red\\033[0m'", "tty":true, "yield_time_ms":10000})).await;
    let mut subscription = tool
        .subscribe(&session, first["session_id"].as_str().unwrap(), 0)
        .unwrap();
    let mut bytes = Vec::new();
    while let Some(event) = subscription.recv().await.unwrap() {
        if let TerminalEvent::Output { chunk, .. } = event {
            assert_eq!(chunk.stream, TerminalStream::Terminal);
            bytes.extend(STANDARD.decode(chunk.data_base64).unwrap());
        }
    }
    assert_eq!(bytes, b"\x1b[31m\xffred\x1b[0m");
    session.close().await.unwrap();
}

#[tokio::test]
async fn completed_subscriptions_do_not_keep_the_process_capacity_reserved() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"printf retained"}),
    )
    .await;
    let id = first["session_id"].as_str().unwrap();
    let mut finished = tool.subscribe(&session, id, 0).unwrap();
    collect(&mut finished).await;
    for _ in 0..64 {
        let result = output(&tools, &session, json!({"action":"exec", "cmd":"true"})).await;
        assert_eq!(result["exit_code"], 0);
    }
    assert!(finished.recv().await.unwrap().is_none());
    session.close().await.unwrap();
}

#[tokio::test]
async fn an_unread_subscription_protects_completed_output_from_automatic_reclamation() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"printf must-survive"}),
    )
    .await;
    let id = first["session_id"].as_str().unwrap();
    let mut unread = tool.subscribe(&session, id, 0).unwrap();
    for _ in 0..128 {
        output(&tools, &session, json!({"action":"exec", "cmd":"true"})).await;
    }
    let (bytes, _, exit) = collect(&mut unread).await;
    assert_eq!(bytes, b"must-survive");
    assert_eq!(exit.exit_code, Some(0));
    session.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_recv_preserves_cursor_and_resubscription_can_continue_from_it() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"cat", "stdin":true, "yield_time_ms":0}),
    )
    .await;
    let id = first["session_id"].as_str().unwrap();
    let mut subscription = tool.subscribe(&session, id, 0).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(30), subscription.recv())
            .await
            .is_err()
    );
    assert_eq!(subscription.next_offset(), 0);
    let written = output(&tools, &session, json!({"action":"write", "session_id":id, "data_base64":STANDARD.encode(b"\xff\0first"), "yield_time_ms":100})).await;
    assert_eq!(written["status"], "running");
    let Some(TerminalEvent::Output { chunk, .. }) = subscription.recv().await.unwrap() else {
        panic!("缺少原始输出")
    };
    assert_eq!(STANDARD.decode(chunk.data_base64).unwrap(), b"\xff\0first");
    let offset = subscription.next_offset();
    drop(subscription);
    let mut resumed = tool.subscribe(&session, id, offset).unwrap();
    output(&tools, &session, json!({"action":"write", "session_id":id, "data_base64":STANDARD.encode(b"\xfesecond"), "close_stdin":true, "yield_time_ms":10000})).await;
    let (tail, errors, _) = collect(&mut resumed).await;
    assert_eq!(tail, b"\xfesecond");
    assert!(errors.is_empty());
    session.close().await.unwrap();
}

#[tokio::test]
async fn explicit_release_ends_subscriptions_and_foreign_sessions_cannot_subscribe() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let stranger = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"printf retained"}),
    )
    .await;
    let id = first["session_id"].as_str().unwrap();
    assert!(tool.subscribe(&stranger, id, 0).is_err());
    let mut subscription = tool.subscribe(&session, id, 0).unwrap();
    output(
        &tools,
        &session,
        json!({"action":"release", "session_id":id}),
    )
    .await;
    assert!(subscription.recv().await.unwrap_err().contains("释放"));
    assert!(subscription.recv().await.unwrap().is_none());
    session.close().await.unwrap();
    stranger.close().await.unwrap();
}

#[tokio::test]
async fn session_close_wakes_idle_subscriptions_and_does_not_require_dropping_them() {
    let (tool, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"cat", "stdin":true, "yield_time_ms":0}),
    )
    .await;
    let mut subscription = tool
        .subscribe(&session, first["session_id"].as_str().unwrap(), 0)
        .unwrap();
    session.close().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), subscription.recv())
        .await
        .unwrap();
    assert!(result.unwrap_err().contains("关闭"));
    assert!(subscription.recv().await.unwrap().is_none());
}

#[tokio::test]
async fn host_can_remove_log_limits_for_output_larger_than_the_default_capacity() {
    let (_, tools) = setup();
    let session = AgentSession::with_terminal_log_limits(TerminalLogLimits {
        process_bytes: None,
        session_bytes: None,
    })
    .unwrap();
    let count = 65 * 1024 * 1024;
    let first = output(&tools, &session, json!({"action":"exec", "cmd":format!("head -c {count} /dev/zero | tr '\\000' x"), "yield_time_ms":10000, "max_output_chars":256})).await;
    assert_eq!(first["status"], "exited", "{first:?}");
    assert_eq!(first["exit_code"], 0);
    let tail = output(&tools, &session, json!({"action":"read_bytes", "session_id":first["session_id"], "offset":count-1000, "max_output_bytes":1000})).await;
    let bytes: Vec<_> = tail["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|chunk| {
            STANDARD
                .decode(chunk["data_base64"].as_str().unwrap())
                .unwrap()
        })
        .collect();
    assert_eq!(bytes, vec![b'x'; 1000]);
    assert_eq!(tail["total_bytes"], count);
    assert_eq!(tail["has_more"], false);
    session.close().await.unwrap();
}

#[tokio::test]
async fn configurable_session_quota_is_shared_and_release_returns_disk_budget() {
    let (_, tools) = setup();
    let session = AgentSession::with_terminal_log_limits(TerminalLogLimits {
        process_bytes: Some(200000),
        session_bytes: Some(300000),
    })
    .unwrap();
    let mut ids = Vec::new();
    for _ in 0..2 {
        let result = output(
            &tools,
            &session,
            json!({"action":"exec", "cmd":"head -c 128000 /dev/zero", "yield_time_ms":10000}),
        )
        .await;
        assert_eq!(result["exit_code"], 0);
        ids.push(result["session_id"].clone());
    }
    let full = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"head -c 128000 /dev/zero", "yield_time_ms":10000}),
    )
    .await;
    assert_eq!(full["status"], "failed");
    assert!(
        full["error"]
            .as_str()
            .unwrap()
            .contains("会话日志超过 300000 字节")
    );
    output(
        &tools,
        &session,
        json!({"action":"release", "session_id":ids.remove(0)}),
    )
    .await;
    let recovered = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"head -c 128000 /dev/zero", "yield_time_ms":10000}),
    )
    .await;
    assert_eq!(recovered["exit_code"], 0);
    output(
        &tools,
        &session,
        json!({"action":"release", "session_id":full["session_id"]}),
    )
    .await;
    session.close().await.unwrap();
    for limits in [
        TerminalLogLimits {
            process_bytes: Some(0),
            session_bytes: None,
        },
        TerminalLogLimits {
            process_bytes: None,
            session_bytes: Some(0),
        },
    ] {
        assert!(AgentSession::with_terminal_log_limits(limits).is_err());
    }
}

#[tokio::test]
async fn invalid_binary_input_is_rejected_without_writing_or_closing_stdin() {
    let (_, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"cat", "stdin":true, "yield_time_ms":0}),
    )
    .await;
    let id = &first["session_id"];
    for encoded in ["%%%".into(), STANDARD.encode(vec![0; 16385])] {
        let invalid = call(
            &tools,
            &session,
            json!({"action":"write", "session_id":id, "data_base64":encoded, "close_stdin":true}),
        )
        .await;
        assert!(invalid.is_error);
    }
    let valid = output(&tools, &session, json!({"action":"write", "session_id":id, "data_base64":STANDARD.encode(b"correct"), "close_stdin":true})).await;
    assert_eq!(valid["output"], "correct");
    session.close().await.unwrap();
}

#[tokio::test]
async fn raw_ctrl_c_cannot_be_misinterpreted_as_a_signal_when_stdin_was_not_opened() {
    let (_, tools) = setup();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"sleep 30", "yield_time_ms":0}),
    )
    .await;
    let rejected = call(
        &tools,
        &session,
        json!({"action":"write", "session_id":first["session_id"], "data_base64":"Aw=="}),
    )
    .await;
    assert!(rejected.is_error);
    assert!(
        rejected.output["error"]
            .as_str()
            .unwrap()
            .contains("stdin 已关闭")
    );
    let listed = output(&tools, &session, json!({"action":"list"})).await;
    assert_eq!(listed["terminals"][0]["status"], "running");
    session.close().await.unwrap();
}
