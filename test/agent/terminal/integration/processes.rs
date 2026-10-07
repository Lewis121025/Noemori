#![cfg(unix)]

use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, ToolCall, ToolResult,
    tool::{
        ToolRegistry,
        terminal::{SandboxMode, TerminalTool},
    },
};
use serde_json::{Value, json};
use std::time::Duration;

#[path = "interaction.rs"]
mod interaction_tests;
#[path = "output.rs"]
mod output_tests;
#[path = "shell.rs"]
mod shell_tests;
#[path = "streaming.rs"]
mod streaming_tests;

fn tools() -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::configured(std::env::temp_dir(), "/bin/sh", SandboxMode::Disabled)
                .unwrap(),
        )
        .unwrap();
    tools
}

fn context() -> ExecutionContext {
    ExecutionContext::new(CancellationToken::new(), Duration::from_secs(10)).unwrap()
}

async fn call(tools: &ToolRegistry, session: &AgentSession, arguments: Value) -> ToolResult {
    tools
        .execute_in_session(
            &ToolCall {
                id: "test".into(),
                name: "terminal".into(),
                arguments,
            },
            context(),
            session,
        )
        .await
        .unwrap()
}

async fn output(tools: &ToolRegistry, session: &AgentSession, arguments: Value) -> Value {
    let result = call(tools, session, arguments).await;
    assert!(!result.is_error, "{:?}", result.output);
    result.output
}

#[tokio::test]
async fn pipe_returns_stdout_stderr_exit_code_and_incremental_output() {
    let tools = tools();
    let session = AgentSession::new();
    let result = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf '正常输出'; printf '错误原因' >&2; exit 7"}),
    )
    .await;
    assert_eq!(result["status"], "exited");
    assert_eq!(result["exit_code"], 7);
    assert!(result["output"].as_str().unwrap().contains("正常输出"));
    assert!(result["output"].as_str().unwrap().contains("错误原因"));
    let next = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":result["session_id"],"yield_time_ms":0}),
    )
    .await;
    assert_eq!(next["output"], "");
    assert_eq!(next["exit_code"], 7);
    session.close().await.unwrap();
}

#[tokio::test]
async fn pty_accepts_input_and_preserves_split_utf8() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"stty -echo; printf '\\303'; read value; printf '\\251:%s' \"$value\"","tty":true,"yield_time_ms":100})).await;
    assert_eq!(first["status"], "running");
    assert_eq!(first["output"], "");
    let last = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"input":"你好\n"}),
    )
    .await;
    assert_eq!(last["status"], "exited");
    assert_eq!(last["output"], "é:你好");
    session.close().await.unwrap();
}

#[tokio::test]
async fn yield_and_command_timeout_have_distinct_lifetimes() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"sleep 0.1; printf finished","yield_time_ms":0}),
    )
    .await;
    assert_eq!(first["status"], "running");
    let last = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"]}),
    )
    .await;
    assert_eq!(last["status"], "exited");
    assert_eq!(last["output"], "finished");
    let timed = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"sleep 30","timeout_ms":50}),
    )
    .await;
    assert_eq!(timed["status"], "timed_out");
    assert!(timed["signal"].as_str().unwrap().starts_with("SIG"));
    session.close().await.unwrap();
}

#[tokio::test]
async fn session_identity_is_host_owned_and_registry_clones_do_not_leak_processes() {
    let tools = tools();
    let a = AgentSession::new();
    let b = AgentSession::new();
    let first = output(
        &tools,
        &a,
        json!({"action":"exec","cmd":"sleep 30","yield_time_ms":0}),
    )
    .await;
    let other = tools.clone();
    assert!(
        output(&other, &b, json!({"action":"list"})).await["terminals"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    for action in ["interact", "stop"] {
        let error = call(
            &other,
            &b,
            json!({"action":action,"session_id":first["session_id"]}),
        )
        .await;
        assert!(error.is_error);
        assert!(
            error.output["error"]
                .as_str()
                .unwrap()
                .contains("此会话中不存在")
        );
    }
    let own = output(&other, &a, json!({"action":"list"})).await;
    assert_eq!(own["terminals"][0]["status"], "running");
    assert!(own["terminals"][0].get("pid").is_none());
    a.close().await.unwrap();
    b.close().await.unwrap();
}

#[tokio::test]
async fn pipe_stdin_errors_are_explicit_and_ctrl_c_preserves_trap_exit_code() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"trap 'printf interrupted; exit 23' INT; printf ready; while :; do sleep 1; done","yield_time_ms":100})).await;
    assert_eq!(first["output"], "ready");
    let error = call(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"input":"hello"}),
    )
    .await;
    assert!(error.is_error);
    assert!(
        error.output["error"]
            .as_str()
            .unwrap()
            .contains("stdin 已关闭")
    );
    let last = output(&tools, &session, json!({"action":"interact","session_id":first["session_id"],"input":"\u{3}","yield_time_ms":2000})).await;
    assert_eq!(last["exit_code"], 23);
    assert!(last["output"].as_str().unwrap().contains("interrupted"));
    session.close().await.unwrap();
}

#[tokio::test]
async fn stop_escalates_when_term_is_ignored_and_repeated_stop_is_idempotent() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"trap '' TERM; printf ready; while :; do sleep 1; done","yield_time_ms":100})).await;
    assert_eq!(first["output"], "ready");
    let last = output(
        &tools,
        &session,
        json!({"action":"stop","session_id":first["session_id"]}),
    )
    .await;
    assert_eq!(last["status"], "stopped");
    assert_eq!(last["signal"], "SIGKILL");
    let again = output(
        &tools,
        &session,
        json!({"action":"stop","session_id":first["session_id"]}),
    )
    .await;
    assert_eq!(again["status"], "stopped");
    assert_eq!(again["output"], "");
    session.close().await.unwrap();
    session.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_exec_wait_preserves_registered_process_and_all_pending_output() {
    let tools = tools();
    let session = AgentSession::new();
    let ctx = context();
    let cancel = ctx.cancellation.clone();
    let task_tools = tools.clone();
    let task_session = session.clone();
    let task = tokio::spawn(async move {
        task_tools.execute_in_session(&ToolCall { id:"cancel".into(), name:"terminal".into(), arguments:json!({"action":"exec","cmd":"printf retained; sleep 30","yield_time_ms":30000}) }, ctx, &task_session).await
    });
    let id = wait_for_terminal(&tools, &session).await;
    cancel.cancel();
    assert!(matches!(
        task.await.unwrap(),
        Err(noemori_agent::Error::Cancelled)
    ));
    let result = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":id,"yield_time_ms":100}),
    )
    .await;
    assert_eq!(result["status"], "running");
    assert_eq!(result["output"], "retained");
    session.close().await.unwrap();
}

async fn wait_for_terminal(tools: &ToolRegistry, session: &AgentSession) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let list = output(tools, session, json!({"action":"list"})).await;
            if let Some(terminal) = list["terminals"].as_array().unwrap().first() {
                return terminal["session_id"].clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn cancelled_interact_does_not_consume_output_or_cancel_other_processes() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"sleep 0.05; printf retained; sleep 30","yield_time_ms":0}),
    )
    .await;
    let ctx = context();
    let cancel = ctx.cancellation.clone();
    let call = ToolCall {
        id: "poll".into(),
        name: "terminal".into(),
        arguments: json!({"action":"interact","session_id":first["session_id"],"yield_time_ms":30000}),
    };
    let wait = tools.execute_in_session(&call, ctx, &session);
    tokio::pin!(wait);
    tokio::select! { result = &mut wait => panic!("意外返回：{result:?}"), _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
    cancel.cancel();
    assert!(matches!(wait.await, Err(noemori_agent::Error::Cancelled)));
    let next = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"yield_time_ms":0}),
    )
    .await;
    assert_eq!(next["output"], "retained");
    session.close().await.unwrap();
}

#[tokio::test]
async fn working_directory_is_explicit_and_commands_do_not_share_shell_state() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("with spaces")).unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(TerminalTool::configured(dir.path(), "/bin/sh", SandboxMode::Disabled).unwrap())
        .unwrap();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"pwd; export NOEMORI_TERMINAL_TEST=changed; cd /","workdir":"with spaces"})).await;
    assert_eq!(
        first["output"].as_str().unwrap().trim(),
        dir.path()
            .join("with spaces")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
    );
    let second = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf '%s' \"${NOEMORI_TERMINAL_TEST-unset}\""}),
    )
    .await;
    assert_eq!(second["output"], "unset");
    let error = call(
        &tools,
        &session,
        json!({"action":"exec","cmd":"true","workdir":"missing"}),
    )
    .await;
    assert!(error.is_error);
    assert!(error.output["error"].as_str().unwrap().contains("工作目录"));
    session.close().await.unwrap();
}

#[tokio::test]
async fn flood_output_is_bounded_and_keeps_the_final_failure() {
    let tools = tools();
    let session = AgentSession::new();
    let result = output(&tools, &session, json!({"action":"exec","cmd":"printf START; head -c 1200000 /dev/zero | tr '\\000' x; printf END; exit 2","max_output_chars":1024,"yield_time_ms":10000})).await;
    assert_eq!(result["status"], "exited");
    assert_eq!(result["exit_code"], 2);
    let text = result["output"].as_str().unwrap();
    assert!(text.starts_with("START"));
    assert!(text.ends_with("END"));
    assert!(text.chars().count() <= 1024);
    assert_eq!(result["truncated"], true);
    assert_eq!(result["omitted_chars"], 1_200_008 - (1024 - 64));
    session.close().await.unwrap();
}

async fn assert_process_gone(pid: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
                Err(nix::errno::Errno::ESRCH) => break,
                Ok(()) => {}
                Err(error) => panic!("无法检查测试进程：{error}"),
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("进程未被回收");
}

async fn assert_not_running(pid: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = tokio::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .await
                .unwrap();
            let state = String::from_utf8(status.stdout).unwrap();
            // 非直接子进程的僵尸由系统接管回收，不能用 waitpid 跨父子关系回收。
            if state.trim().is_empty() || state.trim().starts_with('Z') {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("子进程仍在执行");
}

#[tokio::test]
async fn stop_cleans_group_and_normal_parent_exit_cleans_remaining_children() {
    for tty in [false, true] {
        let tools = tools();
        let session = AgentSession::new();
        let first = output(&tools, &session, json!({"action":"exec","cmd":"sleep 30 & printf '%s %s' \"$$\" \"$!\"; wait","tty":tty,"yield_time_ms":100})).await;
        let pids: Vec<i32> = first["output"]
            .as_str()
            .unwrap()
            .split_whitespace()
            .map(|s| s.parse().unwrap())
            .collect();
        assert_eq!(pids.len(), 2);
        output(
            &tools,
            &session,
            json!({"action":"stop","session_id":first["session_id"]}),
        )
        .await;
        assert_process_gone(pids[0]).await;
        assert_not_running(pids[1]).await;
        let exited = output(
            &tools,
            &session,
            json!({"action":"exec","cmd":"sleep 30 & printf '%s' \"$!\"","tty":tty}),
        )
        .await;
        assert_eq!(exited["status"], "exited", "{exited:?}");
        assert_not_running(exited["output"].as_str().unwrap().trim().parse().unwrap()).await;
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn dropping_last_session_owner_stops_and_reaps_processes() {
    let tools = tools();
    let session = AgentSession::new();
    let clone = session.clone();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf '%s' \"$$\"; exec sleep 30","yield_time_ms":100}),
    )
    .await;
    let pid = first["output"].as_str().unwrap().parse().unwrap();
    drop(session);
    assert_eq!(
        output(&tools, &clone, json!({"action":"list"})).await["terminals"][0]["status"],
        "running"
    );
    drop(clone);
    assert_process_gone(pid).await;
}

#[tokio::test]
async fn closing_a_session_cancels_waits_and_cleanup_survives_a_dropped_close_future() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"trap '' TERM; printf '%s' \"$$\"; while :; do sleep 1; done","yield_time_ms":100})).await;
    let pid = first["output"].as_str().unwrap().parse().unwrap();
    let ctx = context();
    let parent = ctx.cancellation.clone();
    let command = ToolCall {
        id: "wait".into(),
        name: "terminal".into(),
        arguments: json!({"action":"interact","session_id":first["session_id"],"yield_time_ms":30000}),
    };
    let wait = tools.execute_in_session(&command, ctx, &session);
    tokio::pin!(wait);
    tokio::select! { result = &mut wait => panic!("不应结束：{result:?}"), _ = tokio::task::yield_now() => {} }
    {
        let close = session.close();
        tokio::pin!(close);
        tokio::select! { result = &mut close => panic!("TERM 被忽略，应等待升级：{result:?}"), _ = tokio::time::sleep(Duration::from_millis(20)) => {} }
    }
    assert!(session.is_closed());
    assert!(matches!(wait.await, Err(noemori_agent::Error::Cancelled)));
    assert!(!parent.is_cancelled());
    assert_process_gone(pid).await;
    session.close().await.unwrap();
    let error = tools
        .execute_in_session(&command, context(), &session)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("会话已关闭"));
}

#[tokio::test]
async fn concurrent_polls_deliver_each_piece_of_output_only_once() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"sleep 0.05; printf once","yield_time_ms":0}),
    )
    .await;
    let args = json!({"action":"interact","session_id":first["session_id"]});
    let (a, b) = tokio::join!(
        output(&tools, &session, args.clone()),
        output(&tools, &session, args)
    );
    let text = format!(
        "{}{}",
        a["output"].as_str().unwrap(),
        b["output"].as_str().unwrap()
    );
    assert_eq!(text, "once");
    assert_eq!(a["status"], "exited");
    assert_eq!(b["status"], "exited");
    session.close().await.unwrap();
}

#[tokio::test]
async fn stop_interrupts_a_poll_without_waiting_for_its_requested_yield() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"sleep 30","yield_time_ms":0}),
    )
    .await;
    let poll = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"yield_time_ms":30000}),
    );
    let stop = output(
        &tools,
        &session,
        json!({"action":"stop","session_id":first["session_id"]}),
    );
    let (a, b) = tokio::time::timeout(Duration::from_secs(3), async { tokio::join!(poll, stop) })
        .await
        .unwrap();
    assert_eq!(a["status"], "stopped");
    assert_eq!(b["status"], "stopped");
    session.close().await.unwrap();
}

#[tokio::test]
async fn spawn_failure_is_an_error_observation_and_does_not_register_a_process() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let shell = dir.path().join("invalid-shell");
    std::fs::write(&shell, "#!/noemori-missing-interpreter\n").unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(TerminalTool::configured(dir.path(), shell, SandboxMode::Disabled).unwrap())
        .unwrap();
    let session = AgentSession::new();
    for tty in [false, true] {
        let error = call(
            &tools,
            &session,
            json!({"action":"exec","cmd":"true","tty":tty}),
        )
        .await;
        assert!(error.is_error, "tty={tty}: {error:?}");
        assert!(
            error.output["error"].as_str().unwrap().contains("启动失败"),
            "tty={tty}: {error:?}"
        );
    }
    assert_eq!(
        output(&tools, &session, json!({"action":"list"})).await,
        json!({"terminals":[]})
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn capacity_rejects_new_processes_without_evicting_live_work() {
    let tools = tools();
    let session = AgentSession::new();
    let mut first = Value::Null;
    for index in 0..64 {
        let result = output(
            &tools,
            &session,
            json!({"action":"exec","cmd":"sleep 30","yield_time_ms":0}),
        )
        .await;
        if index == 0 {
            first = result["session_id"].clone();
        }
    }
    let refused = call(
        &tools,
        &session,
        json!({"action":"exec","cmd":"true","yield_time_ms":0}),
    )
    .await;
    assert!(refused.is_error);
    assert!(refused.output["error"].as_str().unwrap().contains("上限"));
    let list = output(&tools, &session, json!({"action":"list"})).await;
    let list = list["terminals"].as_array().unwrap();
    assert_eq!(list.len(), 64);
    assert!(list.iter().all(|item| item["status"] == "running"));
    output(
        &tools,
        &session,
        json!({"action":"stop","session_id":first}),
    )
    .await;
    let next = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf recovered"}),
    )
    .await;
    assert_eq!(next["output"], "recovered");
    session.close().await.unwrap();
}

#[tokio::test]
async fn pty_is_a_real_terminal_and_ctrl_d_completes_the_command() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"test -t 0 && test -t 1 && test -t 2 || exit 8; stty -echo; stty size; cat","tty":true,"yield_time_ms":100})).await;
    assert_eq!(first["status"], "running");
    assert_eq!(first["output"].as_str().unwrap().trim(), "24 120");
    let echo = output(&tools, &session, json!({"action":"interact","session_id":first["session_id"],"input":"line\n","yield_time_ms":100})).await;
    assert_eq!(echo["output"], "line\r\n");
    let done = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"input":"\u{4}"}),
    )
    .await;
    assert_eq!(done["exit_code"], 0);
    session.close().await.unwrap();
}

#[tokio::test]
async fn stopping_pty_unblocks_a_full_input_queue() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"stty raw -echo; printf ready; sleep 30","tty":true,"yield_time_ms":100})).await;
    assert_eq!(first["output"], "ready");
    let input = call(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"input":"x".repeat(16384),"yield_time_ms":30000}),
    );
    let stop = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        output(
            &tools,
            &session,
            json!({"action":"stop","session_id":first["session_id"]}),
        )
        .await
    };
    let (write, stopped) =
        tokio::time::timeout(Duration::from_secs(3), async { tokio::join!(input, stop) })
            .await
            .unwrap();
    assert_eq!(stopped["status"], "stopped");
    if write.is_error {
        assert!(write.output["error"].as_str().unwrap().contains("输入"));
    } else {
        assert_eq!(write.output["status"], "stopped");
    }
    session.close().await.unwrap();
}

#[tokio::test]
async fn invalid_and_incomplete_utf8_are_replaced_only_at_the_stream_boundary() {
    let tools = tools();
    let session = AgentSession::new();
    let result = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf '\\377\\303'"}),
    )
    .await;
    assert_eq!(result["output"], "��");
    assert_eq!(result["truncated"], false);
    session.close().await.unwrap();
}

#[tokio::test]
async fn closing_output_streams_does_not_complete_a_running_command() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"exec 1>&- 2>&-; sleep 0.1; exit 4","yield_time_ms":20}),
    )
    .await;
    assert_eq!(first["status"], "running");
    let last = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"]}),
    )
    .await;
    assert_eq!(last["status"], "exited");
    assert_eq!(last["exit_code"], 4);
    assert_eq!(last["output"], "");
    session.close().await.unwrap();
}

#[tokio::test]
async fn shell_symlink_name_is_preserved_for_shell_and_multicall_binary_semantics() {
    let directory = tempfile::tempdir().unwrap();
    let alias = directory.path().join("named-shell");
    std::os::unix::fs::symlink("/bin/sh", &alias).unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::configured(directory.path(), &alias, SandboxMode::Disabled).unwrap(),
        )
        .unwrap();
    let session = AgentSession::new();
    for tty in [false, true] {
        let result = output(
            &tools,
            &session,
            json!({"action":"exec","cmd":"printf '%s' \"$0\"","tty":tty}),
        )
        .await;
        assert_eq!(result["output"], alias.to_str().unwrap());
    }
    session.close().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn command_timeout_starts_at_spawn_even_if_the_runtime_is_temporarily_busy() {
    use futures::FutureExt;
    let tools = tools();
    let session = AgentSession::new();
    let command = ToolCall {
        id: "start".into(),
        name: "terminal".into(),
        arguments: json!({"action":"exec","cmd":"sleep 30","yield_time_ms":0,"timeout_ms":1000}),
    };
    // 只 poll 一次启动调用，禁止执行器在此期间先调度后台观察任务。
    if let Some(result) = tools
        .execute_in_session(&command, context(), &session)
        .now_or_never()
    {
        assert!(!result.unwrap().is_error);
    }
    let list = output(&tools, &session, json!({"action":"list"})).await;
    let id = list["terminals"][0]["session_id"].clone();
    // 故意占用当前线程，模拟宿主尚未调度观察任务；子进程仍在真实系统中执行。
    std::thread::sleep(Duration::from_millis(1100));
    let last = tokio::time::timeout(
        Duration::from_millis(500),
        output(
            &tools,
            &session,
            json!({"action":"interact","session_id":id}),
        ),
    )
    .await
    .expect("命令时限不应从后台任务获得调度后才开始");
    assert_eq!(last["status"], "timed_out");
    session.close().await.unwrap();
}

#[tokio::test]
async fn timeout_reaches_the_owned_child_after_it_leaves_its_original_group() {
    let tools = tools();
    let session = AgentSession::new();
    // alarm 为修复前的漏杀提供独立退出上限；加入宿主组后只能按 PID 终止，不能向新组广播。
    let command = "exec /usr/bin/perl -MPOSIX -e 'alarm 4; POSIX::setpgid(0, getpgrp(getppid())) == 0 or die $!; $SIG{TERM} = q(IGNORE); $| = 1; print qq(moved\\n); sleep 30'";
    let started = std::time::Instant::now();
    let result = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":command,"timeout_ms":500,"yield_time_ms":6000}),
    )
    .await;
    let elapsed = started.elapsed();
    session.close().await.unwrap();
    assert_eq!(result["output"], "moved\n", "{result:?}");
    assert_eq!(result["status"], "timed_out", "{result:?}");
    assert_eq!(result["signal"], "SIGKILL", "{result:?}");
    assert!(
        elapsed < Duration::from_secs(3),
        "停止被脱离进程组的子进程拖延：{elapsed:?}"
    );
}

#[test]
fn runtime_shutdown_publishes_failure_instead_of_leaving_a_running_terminal() {
    let tools = tools();
    let session = AgentSession::new();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let first = runtime.block_on(output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf '%s' \"$$\"; exec sleep 30","yield_time_ms":100}),
    ));
    let pid = first["output"].as_str().unwrap().parse().unwrap();
    drop(runtime);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(assert_process_gone(pid));
    let last = runtime.block_on(output(&tools, &session, json!({"action":"list"})));
    assert_eq!(last["terminals"][0]["status"], "failed", "{last:?}");
    assert!(
        last["terminals"][0]["error"]
            .as_str()
            .unwrap()
            .contains("观察任务")
    );
    assert!(runtime.block_on(session.close()).is_err());
}

#[test]
fn runtime_shutdown_also_finishes_a_worker_that_has_never_been_polled() {
    use futures::FutureExt;
    let tools = tools();
    let session = AgentSession::new();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    {
        let _entered = runtime.enter();
        let command = ToolCall {
            id: "unpolled".into(),
            name: "terminal".into(),
            arguments: json!({"action":"exec","cmd":"sleep 30","tty":true,"yield_time_ms":0}),
        };
        // 只轮询工具调用，不让运行时调度观察任务，验证资源交接当刻就具备退出守卫。
        let _ = tools
            .execute_in_session(&command, context(), &session)
            .now_or_never();
    }
    drop(runtime);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let last = runtime.block_on(output(&tools, &session, json!({"action":"list"})));
    assert_eq!(last["terminals"][0]["status"], "failed", "{last:?}");
    assert!(runtime.block_on(session.close()).is_err());
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn simultaneous_pty_group_exits_do_not_report_spurious_permission_errors() {
    let tools = tools();
    let session = AgentSession::new();
    // 组长退出会触发 PTY 挂断，后台进程随 SIGHUP 退出，故意与宿主的组清理重叠。
    let results = futures::future::join_all((0..32).map(|_| output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"sleep 30 & sleep 30 & exit 0","tty":true,"yield_time_ms":5000}),
    ))).await;
    let cleanup = session.close().await;
    for result in results {
        assert_eq!(result["status"], "exited", "{result:?}");
        assert_eq!(result["exit_code"], 0, "{result:?}");
    }
    cleanup.unwrap();
}
