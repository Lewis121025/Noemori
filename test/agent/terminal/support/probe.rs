//! 仅供验收的 JSON 行驱动器：让两种执行内核通过相同 stdio 往返接受基准请求。
//! 命令由测试脚本提供；不属于宿主应用或模型的公共接口。

use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, ToolCall,
    tool::{
        ToolRegistry,
        terminal::{SandboxMode, TerminalTool},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{error::Error, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    task::JoinSet,
};

#[derive(Deserialize)]
struct Request {
    id: u64,
    arguments: Value,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut tools = ToolRegistry::new();
    tools.register(TerminalTool::configured(
        std::env::current_dir()?,
        "/bin/sh",
        SandboxMode::Disabled,
    )?)?;
    let session = AgentSession::new();
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            line = input.next_line(), if tasks.len() < 64 => {
                let Some(line) = line? else { break; };
                let request: Request = serde_json::from_str(&line)?;
                let tools = tools.clone();
                let session = session.clone();
                tasks.spawn(async move {
                    let result = tools.execute_in_session(&ToolCall { id:request.id.to_string(), name:"terminal".into(), arguments:request.arguments }, ExecutionContext::new(CancellationToken::new(), Duration::from_secs(60))?, &session).await;
                    Ok::<_, noemori_agent::Error>(match result {
                        Ok(result) if !result.is_error => json!({"id":request.id, "result":result.output}),
                        Ok(result) => json!({"id":request.id, "error":result.output}),
                        Err(error) => json!({"id":request.id, "error":error.to_string()}),
                    })
                });
            }
            Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                let response = serde_json::to_vec(&result??)?;
                output.write_all(&response).await?;
                output.write_all(b"\n").await?;
                output.flush().await?;
            }
        }
    }
    session.close().await?;
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
