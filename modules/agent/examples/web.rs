//! 可运行的注册示例：先构建 Web runtime，再运行 cargo run --example web -- fetch URL。

use noemori_agent::{
    CancellationToken, ExecutionContext, ToolCall,
    tool::{
        ToolRegistry,
        web::{WebLimits, WebRuntime, WebTool},
    },
};
use serde_json::json;
use std::{path::PathBuf, time::Duration};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let [operation, value] = arguments.as_slice() else {
        return Err("用法：web search 关键词 或 web fetch URL".into());
    };
    let input = match operation.as_str() {
        "search" => json!({"type":"search","query":value}),
        "fetch" => json!({"type":"fetch","url":value}),
        _ => return Err("操作只支持 search 和 fetch".into()),
    };
    let runtime = WebRuntime {
        node: std::env::var_os("NOEMORI_WEB_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| "node".into()),
        worker: std::env::var_os("NOEMORI_WEB_WORKER")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web-runtime/dist/main.js")
            }),
        browser: std::env::var_os("NOEMORI_WEB_BROWSER").map(PathBuf::from),
    };
    let mut tools = ToolRegistry::new();
    tools.register(WebTool::new(runtime, WebLimits::default())?)?;
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(70))?;
    let result = tools
        .execute(
            &ToolCall {
                id: "example".into(),
                name: "web".into(),
                arguments: input,
            },
            context,
        )
        .await?;
    println!(
        "{}",
        serde_json::to_string(
            &json!({"output":result.output,"is_error":result.is_error,"media_count":result.media.len()})
        )?
    );
    Ok(())
}
