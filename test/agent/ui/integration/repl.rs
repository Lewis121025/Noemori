use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

struct Guest {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Guest {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_noemori-ui-runtime"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
        }
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
    }
    fn run(&mut self, code: &str, timeout_ms: u64) -> Value {
        self.send(json!({"type":"run","id":"test","code":code,"timeout_ms":timeout_ms}));
        loop {
            let mut line = String::new();
            self.output.read_line(&mut line).unwrap();
            assert!(!line.is_empty(), "执行进程不能在回执前退出");
            let value: Value = serde_json::from_str(&line).unwrap();
            match value["type"].as_str().unwrap() {
                "call" => self.send(json!({"type":"reply","id":value["id"],"value":{"outcome":"observed","tabs":[],"mode":"agent"}})),
                "finished" => return value,
                other => panic!("意外回执：{other}"),
            }
        }
    }
}
impl Drop for Guest {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn lexical_bindings_and_top_level_await_survive_calls() {
    let mut guest = Guest::new();
    assert!(
        guest.run(
            "let n = 7; const b = await browser.get('managed'); print(n);",
            2000
        )["error"]
            .is_null()
    );
    let result = guest.run("n += 2; print(n); print(await b.tabs());", 2000);
    assert_eq!(result["prints"][0], 9);
    assert_eq!(result["prints"][1]["outcome"], "observed");
    assert!(!guest.run("let n = 1;", 2000)["error"].is_null());
    assert_eq!(guest.run("print(n)", 2000)["prints"][0], 9);
}

#[test]
fn exceptions_keep_valid_bindings_and_host_authority_is_absent() {
    let mut guest = Guest::new();
    assert!(!guest.run("var kept = 12; throw new Error('失败');", 2000)["error"].is_null());
    let result = guest.run("print(kept); print(typeof process); print(typeof require); print(typeof fetch); print(typeof setTimeout);", 2000);
    assert_eq!(
        result["prints"],
        json!([12, "undefined", "undefined", "undefined", "undefined"])
    );
    assert!(!guest.run("await import('node:fs')", 2000)["error"].is_null());
}

#[test]
fn runaway_code_resets_context_and_can_run_again() {
    let mut guest = Guest::new();
    guest.run("var previous = 1", 2000);
    let result = guest.run("for (;;) {}", 40);
    assert_eq!(result["reset"], true);
    assert_eq!(
        guest.run("print(typeof previous)", 2000)["prints"][0],
        "undefined"
    );
}

#[test]
fn unawaited_sdk_work_is_settled_before_return() {
    let mut guest = Guest::new();
    let result = guest.run(
        "browser.get('managed').then(b => b.tabs()).then(v => print(v.mode));",
        2000,
    );
    assert_eq!(result["prints"], json!(["agent"]));
}

#[test]
fn output_and_memory_have_hard_limits() {
    let mut guest = Guest::new();
    assert!(!guest.run("print('x'.repeat(1100000))", 2000)["error"].is_null());
    let result = guest.run(
        "var allocations = []; while (true) allocations.push(new Uint8Array(1000000));",
        2000,
    );
    assert!(!result["error"].is_null());
    assert_eq!(result["reset"], true);
    assert!(guest.run("print(1)", 2000)["error"].is_null());
}

#[tokio::test]
async fn guest_cannot_grant_origins_resume_or_bypass_action_limits() {
    use noemori_agent::{
        AgentSession, CancellationToken, ExecutionContext,
        tool::{
            Tool, ToolContext,
            ui::{UiInput, UiTool},
        },
    };
    let tool = UiTool::new(env!("CARGO_BIN_EXE_noemori-ui-runtime").into(), None).unwrap();
    let session = AgentSession::new();
    for (index, action) in [
        json!({"action":"allow_origin","origin":"http://localhost:1"}),
        json!({"action":"resume"}),
        json!({"action":"preview","page":"page"}),
        json!({"action":"human_input","page":"page","input":{"type":"text","text":"越权"}}),
        json!({"action":"open","url":"x".repeat(9000)}),
    ]
    .into_iter()
    .enumerate()
    {
        let request = json!({"domain":"browser","backend":"managed","action":action});
        let code = format!(
            "await __rpc({})",
            serde_json::to_string(&request.to_string()).unwrap()
        );
        let result = tool
            .execute(
                UiInput::Run {
                    code,
                    timeout_ms: 2000,
                },
                ToolContext {
                    call_id: format!("authority-{index}"),
                    execution: ExecutionContext::new(
                        CancellationToken::new(),
                        std::time::Duration::from_secs(3),
                    )
                    .unwrap(),
                    session: session.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(result.operations[0]["outcome"], "not_executed");
        assert!(
            result.operations[0]["error"]
                .as_str()
                .unwrap()
                .contains("Schema")
        );
    }
    session.close().await.unwrap();
}

#[tokio::test]
async fn reset_updates_generation_and_duplicate_call_never_replays() {
    use noemori_agent::{
        AgentSession, CancellationToken, ExecutionContext,
        tool::{
            Tool, ToolContext,
            ui::{UiInput, UiTool},
        },
    };
    let tool = UiTool::new(env!("CARGO_BIN_EXE_noemori-ui-runtime").into(), None).unwrap();
    let session = AgentSession::new();
    let context = |id: &str| ToolContext {
        call_id: id.into(),
        execution: ExecutionContext::new(
            CancellationToken::new(),
            std::time::Duration::from_secs(3),
        )
        .unwrap(),
        session: session.clone(),
    };
    let code = "var runs = (typeof runs === 'undefined' ? 0 : runs) + 1; print(runs)";
    let first = tool
        .execute(
            UiInput::Run {
                code: code.into(),
                timeout_ms: 2000,
            },
            context("same"),
        )
        .await
        .unwrap();
    let duplicate = tool
        .execute(
            UiInput::Run {
                code: code.into(),
                timeout_ms: 2000,
            },
            context("same"),
        )
        .await
        .unwrap();
    assert_eq!(first.prints, duplicate.prints);
    assert_eq!(
        tool.execute(
            UiInput::Run {
                code: "print(runs)".into(),
                timeout_ms: 2000
            },
            context("read")
        )
        .await
        .unwrap()
        .prints,
        json!([1]).as_array().unwrap().clone()
    );
    tool.execute(UiInput::Reset, context("reset"))
        .await
        .unwrap();
    assert_eq!(session.ui_snapshot().generation, 1);
    assert!(session.ui_snapshot().call.is_none());
    let output = tool
        .execute(
            UiInput::Run {
                code: "for (;;) {}".into(),
                timeout_ms: 50,
            },
            context("loop"),
        )
        .await
        .unwrap();
    assert!(output.reset);
    assert_eq!(session.ui_snapshot().generation, 2);
    assert!(session.ui_snapshot().error.is_some());
    session.close().await.unwrap();
    assert_eq!(
        serde_json::to_value(session.ui_snapshot()).unwrap()["status"],
        "closed"
    );
}

#[tokio::test]
async fn computer_cannot_self_grant_or_resume_control() {
    use noemori_agent::{
        AgentSession, CancellationToken, ExecutionContext,
        tool::{
            Tool, ToolContext,
            ui::{UiInput, UiTool},
        },
    };
    let tool = UiTool::new(env!("CARGO_BIN_EXE_noemori-ui-runtime").into(), None).unwrap();
    let session = AgentSession::new();
    for (index, action) in ["grant_control", "resume", "invalidate"]
        .into_iter()
        .enumerate()
    {
        let request = json!({"domain":"computer","action":{"action":action}});
        let code = format!(
            "await __rpc({})",
            serde_json::to_string(&request.to_string()).unwrap()
        );
        let result = tool
            .execute(
                UiInput::Run {
                    code,
                    timeout_ms: 2000,
                },
                ToolContext {
                    call_id: format!("self-grant-{index}"),
                    execution: ExecutionContext::new(
                        CancellationToken::new(),
                        std::time::Duration::from_secs(3),
                    )
                    .unwrap(),
                    session: session.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(result.operations[0]["outcome"], "not_executed");
        assert!(
            result.operations[0]["error"]
                .as_str()
                .unwrap()
                .contains("Schema")
        );
    }
    session.close().await.unwrap();
}
