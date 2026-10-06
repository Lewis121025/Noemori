//! 默认沙箱示例：先 cargo build --bin noemori-terminal-sandbox，
//! 再 cargo run --example terminal -- 'printf hello'。

use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, ToolCall,
    tool::{ToolRegistry, terminal::TerminalTool},
};
use serde_json::json;
use std::time::Duration;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let [command] = arguments.as_slice() else {
        return Err("用法：terminal '待执行命令'".into());
    };
    let mut tools = ToolRegistry::new();
    tools.register(TerminalTool::new(std::env::current_dir()?)?)?;
    let session = AgentSession::new();
    let result = execute(&tools, &session, command).await;
    // 无论调用是否失败，示例退出前都确认资源回收；实际桌面宿主在关闭对话时执行此步骤。
    let cleanup = session.close().await;
    result?;
    cleanup?;
    Ok(())
}

async fn execute(
    tools: &ToolRegistry,
    session: &AgentSession,
    command: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = json!({"action":"exec","cmd":command,"timeout_ms":60000});
    loop {
        let result = tools
            .execute_in_session(
                &ToolCall {
                    id: "example".into(),
                    name: "terminal".into(),
                    arguments,
                },
                ExecutionContext::new(CancellationToken::new(), Duration::from_secs(10))?,
                session,
            )
            .await?;
        if result.is_error {
            return Err(result.output.to_string().into());
        }
        print!("{}", result.output["output"].as_str().unwrap_or_default());
        if result.output["status"] != "running" {
            if result.output["status"] == "exited" && result.output["exit_code"] == 0 {
                return Ok(());
            }
            return Err(format!("终端未成功完成：{}", result.output).into());
        }
        arguments = json!({"action":"interact","session_id":result.output["session_id"]});
    }
}
