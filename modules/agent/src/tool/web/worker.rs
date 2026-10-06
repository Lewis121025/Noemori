//! 单次执行独占进程组，超时或取消会释放浏览器子进程和 PDF 工作线程。

use super::io::{bounded_output, frame_line};
use super::{FetchResult, WebRuntime};
use crate::{ExecutionContext, Image, ImageFormat, tool::ToolError};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

/// 宿主控制帧与最终观察分离，浏览器请求只能改变本次操作拥有的资源。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Frame {
    BrowserStart {
        executable: String,
        proxy_url: String,
    },
    Finished {
        result: Payload,
    },
    SearchFinished {
        result: SearchSnapshot,
    },
    Failed {
        error: String,
    },
}

/// 搜索原始 DOM 只在宿主解析，内部 URL 与说明不混入页面正文或模型控制字段。
#[derive(Debug, Deserialize)]
pub(super) struct SearchSnapshot {
    pub url: String,
    pub html: String,
    pub warnings: Vec<String>,
}

/// 完成帧的语义必须与本次操作一致，不能将 HTML 当成可读正文。
enum Observation {
    Readable(Payload),
    Search(SearchSnapshot),
}

/// 辅助程序提交的完整观察，页图只有验证和解码后才能进入公开工具结果。
#[derive(Deserialize)]
struct Payload {
    title: Option<String>,
    url: String,
    text: String,
    truncated: bool,
    warnings: Vec<String>,
    images: Vec<PageImage>,
}

/// 进程边界上的页图编码，原页码用于把视觉内容关联到 PDF 正文。
#[derive(Deserialize)]
struct PageImage {
    page: usize,
    format: ImageFormat,
    data: String,
}

/// 使用 `runtime` 执行已校验 `input`，在 `context` 期限内返回正文及有类型的图像。
/// 完成、失败和取消都回收宿主资源；协议、解析或清理失败保留明确错误及有界诊断。
pub(super) async fn read(
    runtime: &WebRuntime,
    input: Value,
    context: &ExecutionContext,
) -> Result<FetchResult, ToolError> {
    match run(runtime, input, context).await? {
        Observation::Readable(payload) => result_payload(payload),
        Observation::Search(_) => Err(ToolError::Execution("页面操作返回了搜索 HTML 帧".into())),
    }
}

/// 在 `context` 内处理搜索验证并捕获完整 DOM；进程、协议或清理失败保留原始原因。
pub(super) async fn search_page(
    runtime: &WebRuntime,
    input: Value,
    context: &ExecutionContext,
) -> Result<SearchSnapshot, ToolError> {
    match run(runtime, input, context).await? {
        Observation::Search(snapshot) => Ok(snapshot),
        Observation::Readable(_) => {
            Err(ToolError::Execution("搜索操作没有返回完整 HTML 帧".into()))
        }
    }
}

async fn run(
    runtime: &WebRuntime,
    input: Value,
    context: &ExecutionContext,
) -> Result<Observation, ToolError> {
    let mut resources = super::process::Resources::default();
    let node = resources
        .spawn(
            runtime.node.as_os_str(),
            super::process::ProcessRole::Node,
            |command| {
                command
                    .args(["--max-old-space-size=512", "--use-system-ca"])
                    .arg(&runtime.worker)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());
            },
        )
        .map_err(ToolError::Execution)?;
    let operation = exchange(runtime, &input, node, &mut resources);
    let result = context
        .wait(operation)
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    let cleanup = resources.cleanup().await;
    let payload = match (result, cleanup) {
        (Ok(payload), Ok(())) => payload,
        (Err(error), Ok(())) => return Err(ToolError::Execution(error)),
        (Ok(_), Err(error)) => return Err(ToolError::Execution(error)),
        (Err(error), Err(cleanup)) => {
            return Err(ToolError::Execution(format!(
                "{error}；清理失败：{cleanup}"
            )));
        }
    };
    Ok(payload)
}

async fn exchange(
    runtime: &WebRuntime,
    input: &Value,
    node: usize,
    resources: &mut super::process::Resources,
) -> Result<Observation, String> {
    let stdin = resources
        .child(node)
        .stdin()
        .take()
        .ok_or("辅助进程缺少输入管道")?;
    let stdout = resources
        .child(node)
        .stdout()
        .take()
        .ok_or("辅助进程缺少输出管道")?;
    let stderr = resources
        .child(node)
        .stderr()
        .take()
        .ok_or("辅助进程缺少诊断管道")?;
    let operation = async {
        let payload = protocol(runtime, input, stdin, stdout, resources).await;
        if let Err(error) = &payload {
            resources
                .stop(node)
                .map_err(|cleanup| format!("{error}；{cleanup}"))?;
        }
        // 协议失败作为结果保留，不能让 try_join 提前丢掉 stderr 的具体诊断。
        Ok::<_, String>(payload)
    };
    let (payload, diagnostic) = tokio::try_join!(operation, bounded_output(stderr, 64 * 1024))?;
    let status = resources.wait(node).await?;
    let diagnostic = String::from_utf8_lossy(&diagnostic)
        .chars()
        .take(2048)
        .collect::<String>();
    let diagnostic = if diagnostic.trim().is_empty() {
        String::new()
    } else {
        format!("；{diagnostic}")
    };
    let payload = payload.map_err(|error| format!("{error}{diagnostic}"))?;
    if !status.success() {
        return Err(format!("fetch：辅助进程异常退出 {status}{diagnostic}"));
    }
    Ok(payload)
}

async fn protocol(
    runtime: &WebRuntime,
    input: &Value,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    resources: &mut super::process::Resources,
) -> Result<Observation, String> {
    let mut bytes =
        serde_json::to_vec(input).map_err(|error| format!("辅助输入编码失败：{error}"))?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| format!("辅助输入写入失败：{error}"))?;
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut total = 0usize;
    let mut started = false;
    loop {
        let line = frame_line(&mut reader, 64 * 1024 * 1024 - total).await?;
        let size = line.len();
        total = total
            .checked_add(size)
            .filter(|bytes| *bytes <= 64 * 1024 * 1024)
            .ok_or("辅助输出超过字节上限")?;
        if size == 0 {
            return Err("辅助进程在完成结果前退出".into());
        }
        let frame: Frame = serde_json::from_slice(&line)
            .map_err(|error| format!("辅助进程返回无效控制消息：{error}"))?;
        match frame {
            Frame::BrowserStart {
                executable,
                proxy_url,
            } => {
                if started
                    || !matches!(
                        input.get("operation").and_then(Value::as_str),
                        Some("page" | "search")
                    )
                {
                    return Err("辅助进程请求了不属于当前操作的浏览器资源".into());
                }
                started = true;
                let executable = runtime
                    .browser
                    .as_deref()
                    .unwrap_or(std::path::Path::new(&executable));
                let (pid, endpoint) = resources
                    .browser(executable.as_os_str(), &proxy_url)
                    .await?;
                let mut reply = serde_json::to_vec(
                    &serde_json::json!({"kind":"browser_ready","pid":pid,"endpoint":endpoint}),
                )
                .map_err(|error| error.to_string())?;
                reply.push(b'\n');
                stdin
                    .write_all(&reply)
                    .await
                    .map_err(|error| format!("浏览器租约返回失败：{error}"))?;
            }
            Frame::Finished { result } => {
                stdin.shutdown().await.map_err(|error| error.to_string())?;
                drop(stdin);
                return Ok(Observation::Readable(result));
            }
            Frame::SearchFinished { result } => {
                if input.get("operation").and_then(Value::as_str) != Some("search") {
                    return Err("非搜索操作返回了搜索 HTML 帧".into());
                }
                stdin.shutdown().await.map_err(|error| error.to_string())?;
                drop(stdin);
                return Ok(Observation::Search(result));
            }
            Frame::Failed { error } => return Err(format!("web：{error}")),
        }
    }
}

fn result_payload(payload: Payload) -> Result<FetchResult, ToolError> {
    let mut images = Vec::new();
    let mut rendered_pages = Vec::new();
    for page in payload.images {
        let bytes = STANDARD
            .decode(page.data)
            .map_err(|_| ToolError::Execution("PDF 页图 Base64 无效".into()))?;
        images.push(
            Image::new(page.format, bytes)
                .map_err(|error| ToolError::Execution(error.to_string()))?,
        );
        rendered_pages.push(page.page);
    }
    Ok(FetchResult {
        title: payload.title,
        url: payload.url,
        text: payload.text,
        truncated: payload.truncated,
        warnings: payload.warnings,
        rendered_pages,
        images,
    })
}

#[cfg(test)]
#[path = "../../../../../test/agent/web/integration/worker.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../../../test/agent/web/unit/worker.rs"]
mod unit_tests;
