#![cfg(unix)]

#[path = "../../support/model.rs"]
mod support;

use async_trait::async_trait;
use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, Message, Role, ToolCall,
    runtime::{Agent, RunInput, RunOptions, RunStatus},
    tool::{
        Tool, ToolConcurrency, ToolContext, ToolError, ToolRegistry,
        terminal::{
            SandboxConfig, SandboxMode, TerminalInput, TerminalOutput, TerminalTool,
            WorkspaceAccess,
        },
    },
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use support::{ScriptedModel, answer, calls};

fn registry(workspace: &Path, mode: SandboxMode) -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    tools
        .register(TerminalTool::configured(workspace, "/bin/sh", mode).unwrap())
        .unwrap();
    tools
}

async fn call(tools: &ToolRegistry, session: &AgentSession, arguments: Value) -> Value {
    let result = tools
        .execute_in_session(
            &ToolCall {
                id: "stress".into(),
                name: "terminal".into(),
                arguments,
            },
            ExecutionContext::new(CancellationToken::new(), Duration::from_secs(60)).unwrap(),
            session,
        )
        .await
        .unwrap();
    assert!(!result.is_error, "{result:?}");
    result.output
}

async fn runtime_root(tools: &ToolRegistry, session: &AgentSession) -> PathBuf {
    let result = call(
        tools,
        session,
        json!({"action":"exec","cmd":"command -v rg"}),
    )
    .await;
    assert_eq!(result["exit_code"], 0);
    let executable = PathBuf::from(result["output"].as_str().unwrap().trim());
    call(
        tools,
        session,
        json!({"action":"release","session_id":result["session_id"]}),
    )
    .await;
    executable.parent().unwrap().parent().unwrap().to_owned()
}

fn open_descriptors() -> usize {
    let directory = if cfg!(target_os = "linux") {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    };
    std::fs::read_dir(directory).unwrap().count()
}

fn log_files(root: &Path) -> usize {
    std::fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("output-"))
        .count()
}

#[tokio::test]
#[ignore = "由 pnpm test:agent:stress 单独执行资源与耗时验收"]
async fn repeated_processes_release_descriptors_and_private_logs() {
    let workspace = tempfile::tempdir().unwrap();
    let tools = registry(workspace.path(), SandboxMode::Disabled);
    let session = AgentSession::new();
    let root = runtime_root(&tools, &session).await;
    for _ in 0..8 {
        let result = call(
            &tools,
            &session,
            json!({"action":"exec","cmd":"printf warmup","tty":true}),
        )
        .await;
        call(
            &tools,
            &session,
            json!({"action":"release","session_id":result["session_id"]}),
        )
        .await;
    }
    let before = open_descriptors();
    let started = Instant::now();
    for index in 0..200 {
        let text = format!("cycle-{index}-中文🙂");
        let result = call(
            &tools,
            &session,
            json!({"action":"exec","cmd":format!("printf '{text}'"),"tty":index % 3 == 0}),
        )
        .await;
        assert_eq!(result["exit_code"], 0, "{result:?}");
        assert_eq!(result["output"], text);
        let replay = call(
            &tools,
            &session,
            json!({"action":"read","session_id":result["session_id"]}),
        )
        .await;
        assert_eq!(replay["output"], text);
        call(
            &tools,
            &session,
            json!({"action":"release","session_id":result["session_id"]}),
        )
        .await;
    }
    session.close().await.unwrap();
    let after = open_descriptors();
    assert!(
        after <= before + 4,
        "描述符数量持续增长：{before} -> {after}"
    );
    assert_eq!(log_files(&root), 0);
    println!(
        "{}",
        json!({"case":"process_lifecycle", "cycles":200, "elapsed_ms":started.elapsed().as_millis(), "fds_before":before, "fds_after":after, "remaining_logs":0})
    );
}

#[tokio::test]
#[ignore = "由 pnpm test:agent:stress 验证真实磁盘日志配额"]
async fn session_log_quota_is_shared_and_reclaimed_after_release() {
    let workspace = tempfile::tempdir().unwrap();
    let tools = registry(workspace.path(), SandboxMode::Disabled);
    let session = AgentSession::new();
    let root = runtime_root(&tools, &session).await;
    let mut sessions = Vec::new();
    let started = Instant::now();
    for _ in 0..4 {
        let result = call(&tools, &session, json!({"action":"exec","cmd":"head -c 62914560 /dev/zero | tr '\\000' x","yield_time_ms":30000,"max_output_chars":256})).await;
        assert_eq!(result["exit_code"], 0, "{result:?}");
        assert_eq!(result["truncated"], true);
        let replay = call(&tools, &session, json!({"action":"read","session_id":result["session_id"],"offset":62914560-256,"max_output_chars":256})).await;
        assert_eq!(replay["output"], "x".repeat(256));
        assert_eq!(replay["total_bytes"], 62914560_u64);
        sessions.push(result["session_id"].clone());
    }
    let full = call(
        &tools,
        &session,
        json!({"action":"exec","cmd":"head -c 25165824 /dev/zero | tr '\\000' x","yield_time_ms":30000,"max_output_chars":256}),
    )
    .await;
    assert_eq!(full["status"], "failed");
    assert!(full["error"].as_str().unwrap().contains("256 MiB"));
    let stored_bytes: u64 = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("output-"))
        .map(|entry| entry.metadata().unwrap().len())
        .sum();
    assert!(stored_bytes <= 256 * 1024 * 1024);
    assert!(stored_bytes > 256 * 1024 * 1024 - 16384);
    call(
        &tools,
        &session,
        json!({"action":"release","session_id":sessions.remove(0)}),
    )
    .await;
    let recovered = call(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf recovered"}),
    )
    .await;
    assert_eq!(recovered["exit_code"], 0);
    assert_eq!(recovered["output"], "recovered");
    sessions.extend([full["session_id"].clone(), recovered["session_id"].clone()]);
    for id in sessions {
        call(
            &tools,
            &session,
            json!({"action":"release","session_id":id}),
        )
        .await;
    }
    session.close().await.unwrap();
    assert_eq!(log_files(&root), 0);
    println!(
        "{}",
        json!({"case":"shared_log_quota", "stored_bytes":stored_bytes, "capacity_bytes":268435456_u64, "elapsed_ms":started.elapsed().as_millis(), "quota_reclaimed":true, "remaining_logs":0})
    );
}

/// 串行基线通过工具声明形成屏障，避免给生产调度器重新引入数量限制。
struct ScheduledTerminal {
    terminal: TerminalTool,
    concurrency: ToolConcurrency,
}

#[async_trait]
impl Tool for ScheduledTerminal {
    type Args = TerminalInput;
    type Output = TerminalOutput;
    fn name(&self) -> &str {
        self.terminal.name()
    }
    fn description(&self) -> &str {
        self.terminal.description()
    }
    fn concurrency(&self, _: &TerminalInput) -> ToolConcurrency {
        self.concurrency
    }
    async fn execute(
        &self,
        args: TerminalInput,
        context: ToolContext,
    ) -> Result<TerminalOutput, ToolError> {
        self.terminal.execute(args, context).await
    }
}

async fn batch_duration(workspace: &Path, concurrency: ToolConcurrency) -> Duration {
    let mut tools = ToolRegistry::new();
    tools
        .register(ScheduledTerminal {
            terminal: TerminalTool::configured(
                workspace,
                "/bin/sh",
                SandboxMode::Restricted(SandboxConfig {
                    workspace_access: WorkspaceAccess::ReadOnly,
                    ..Default::default()
                }),
            )
            .unwrap(),
            concurrency,
        })
        .unwrap();
    let ids: Vec<_> = (0..8).map(|index| format!("call-{index}")).collect();
    let requests: Vec<_> = ids
        .iter()
        .map(|id| {
            (
                id.as_str(),
                "terminal",
                json!({"action":"exec","cmd":"sleep 0.15; printf done","yield_time_ms":1000}),
            )
        })
        .collect();
    let model = Arc::new(ScriptedModel::new(vec![
        vec![calls(&requests)],
        vec![answer("done")],
    ]));
    let agent = Agent::new(model, tools, RunOptions::default()).unwrap();
    let session = AgentSession::new();
    let mut input = RunInput::new(vec![Message::text(Role::User, "并发读取")]);
    input.session = session.clone();
    let start = Instant::now();
    assert!(matches!(
        agent.run(input).await.unwrap().status,
        RunStatus::Completed
    ));
    session.close().await.unwrap();
    start.elapsed()
}

#[tokio::test]
#[ignore = "由 pnpm test:agent:stress 输出相同任务的串行与并发耗时"]
async fn independent_readonly_commands_report_measured_parallel_speedup() {
    let workspace = tempfile::tempdir().unwrap();
    let mut serial = Vec::new();
    let mut parallel = Vec::new();
    for _ in 0..3 {
        serial.push(batch_duration(workspace.path(), ToolConcurrency::Sequential).await);
        parallel.push(batch_duration(workspace.path(), ToolConcurrency::Concurrent).await);
    }
    serial.sort();
    parallel.sort();
    // 并发正确性由事件和状态断言验证；这里记录实测值，避免把机器负载波动当作功能失败。
    println!(
        "{}",
        json!({"case":"readonly_parallelism", "commands":8, "samples":3, "serial_median_ms":serial[1].as_millis(), "parallel_median_ms":parallel[1].as_millis(), "speedup":serial[1].as_secs_f64()/parallel[1].as_secs_f64()})
    );
}
