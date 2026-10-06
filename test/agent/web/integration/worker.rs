use super::*;
use crate::CancellationToken;
use std::time::Duration;

fn runtime() -> WebRuntime {
    WebRuntime {
        node: "node".into(),
        worker: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/agent/web/support/worker-fixture.mjs"),
        browser: None,
    }
}

#[tokio::test]
async fn worker_errors_preserve_the_actual_reason() {
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap();
    let error = read(&runtime(), serde_json::json!({"mode":"error"}), &context)
        .await
        .unwrap_err();
    assert!(
        matches!(&error,ToolError::Execution(reason) if reason.contains("文档需要密码")),
        "{error:?}"
    );
}

#[tokio::test]
async fn anonymous_browser_does_not_expose_the_webdriver_automation_flag() {
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(10)).unwrap();
    let result = read(
        &runtime(),
        serde_json::json!({"operation":"page","mode":"browser_properties"}),
        &context,
    )
    .await
    .unwrap();
    assert_eq!(result.text, "false");
}

#[tokio::test]
async fn an_unexpected_worker_exit_preserves_stderr_diagnostics() {
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap();
    let error = read(
        &runtime(),
        serde_json::json!({"mode":"stderr_only"}),
        &context,
    )
    .await
    .unwrap_err();
    assert!(
        matches!(&error,ToolError::Execution(reason) if reason.contains("受控解析器异常")),
        "{error:?}"
    );
}

#[tokio::test]
async fn an_invalid_frame_stops_worker_before_collecting_diagnostics() {
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap();
    let error = read(
        &runtime(),
        serde_json::json!({"mode":"invalid_frame"}),
        &context,
    )
    .await
    .unwrap_err();
    assert!(
        matches!(&error, ToolError::Execution(reason)
        if reason.contains("无效控制消息") && reason.contains("受控协议异常")),
        "{error:?}"
    );
}

#[tokio::test]
async fn search_html_uses_a_separate_frame_and_cannot_be_mistaken_for_readable_text() {
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap();
    let input = serde_json::json!({"operation":"search","mode":"search_success"});
    let snapshot = search_page(&runtime(), input.clone(), &context)
        .await
        .unwrap();
    assert_eq!(snapshot.url, "https://www.bing.com/search?q=fixture");
    assert_eq!(snapshot.warnings, ["部分资源未完成"]);
    let results = super::super::search::parse_search_page(
        super::super::search::SearchEngine::Bing,
        &snapshot.html,
    )
    .unwrap();
    assert_eq!(results[0].title, "验证后的发布说明");
    assert!(
        read(&runtime(), input, &context)
            .await
            .unwrap_err()
            .to_string()
            .contains("搜索 HTML 帧")
    );
    assert!(
        search_page(
            &runtime(),
            serde_json::json!({"operation":"search"}),
            &context
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("完整 HTML 帧")
    );
}

#[tokio::test]
async fn real_search_worker_recovers_verification_and_returns_complete_html() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|value| value == b"\r\n\r\n") {
                let size = socket.read(&mut chunk).await.unwrap();
                if size == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..size]);
                assert!(request.len() <= 16 * 1024);
            }
            let request = String::from_utf8_lossy(&request);
            let passed = request.lines().any(|line| {
                line.to_ascii_lowercase().starts_with("cookie:")
                    && line.contains("clearance=fixture")
            });
            let (status, body) = if passed {
                (
                    200,
                    r#"<html><body><li class="b_algo"><h2><a href="https://example.com/release">完整发布说明</a></h2><p>验证后的完整摘要</p></li></body></html>"#,
                )
            } else {
                (
                    403,
                    r#"<html><main>正在检查浏览器。</main><script>window._cf_chl_opt={cType:'managed'};document.cookie='clearance=fixture; path=/';setTimeout(()=>location.reload(),300);</script></html>"#,
                )
            };
            let response = format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let runtime = WebRuntime {
        worker: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("web-runtime/dist/main.js"),
        ..runtime()
    };
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(15)).unwrap();
    let result = search_page(&runtime, serde_json::json!({"operation":"search",
        "url":"http://93.184.215.14/search","limits":{"max_chars":16,"max_pages":6,"image_edge":640,"max_download_bytes":1024*1024},
        "timeout_ms":14000,"proxy":{"server":proxy}}), &context).await;
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    let snapshot = result.unwrap();
    let results = super::super::search::parse_search_page(
        super::super::search::SearchEngine::Bing,
        &snapshot.html,
    )
    .unwrap();
    assert_eq!(results[0].title, "完整发布说明");
    assert_eq!(results[0].summary, "验证后的完整摘要");
    assert!(snapshot.html.chars().count() > 16);
}

#[cfg(unix)]
#[tokio::test]
async fn failed_worker_cannot_leave_its_browser_alive() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pids.json");
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(15)).unwrap();
    let result = read(
        &runtime(),
        serde_json::json!({"operation":"page","mode":"error_child","path":path}),
        &context,
    )
    .await;
    assert!(result.is_err());
    let pids: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let pid = pids["child"].as_u64().unwrap();
    let alive = std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .output()
        .unwrap()
        .status
        .success();
    if alive {
        assert!(
            std::process::Command::new("/bin/kill")
                .args(["-KILL", &pid.to_string()])
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    assert!(!alive, "辅助进程返回错误后浏览器仍然存活");
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_kills_detached_browser_like_children() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pids.json");
    let cancellation = CancellationToken::new();
    let context = ExecutionContext::new(cancellation.clone(), Duration::from_secs(10)).unwrap();
    let worker = runtime();
    let target = path.clone();
    let task = tokio::spawn(async move {
        read(
            &worker,
            serde_json::json!({"operation":"page","mode":"wait","path":target}),
            &context,
        )
        .await
    });
    let ready = tokio::time::timeout(Duration::from_secs(5), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(ready.is_ok());
    let pids: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    cancellation.cancel();
    assert!(task.await.unwrap().is_err());
    for name in ["parent", "child"] {
        let pid = pids[name].as_u64().unwrap();
        let stopped = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let live = std::process::Command::new("/bin/kill")
                    .args(["-0", &pid.to_string()])
                    .output()
                    .unwrap()
                    .status
                    .success();
                if !live {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(stopped.is_ok(), "本次子进程 {name} 没有退出");
    }
}
