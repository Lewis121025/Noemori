use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, ToolCall,
    tool::{
        ToolRegistry,
        browser::{BrowserConfig, BrowserStatus, BrowserTool},
    },
};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn tool(workspace: &std::path::Path, origin: String) -> BrowserTool {
    BrowserTool::new(BrowserConfig {
        node: "node".into(),
        worker: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web-runtime/dist/browser/main.js"),
        browser: std::env::var_os("NOEMORI_TEST_BROWSER").map(PathBuf::from),
        workspace: workspace.into(),
        headless: true,
        private_origins: vec![origin],
    })
    .unwrap()
}

async fn site() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut input = [0; 4096];
                let _ = socket.read(&mut input).await;
                let html = "<html><title>浏览器测试</title><label>姓名<input></label><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">保存</button><output></output></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                    html.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (url, task)
}

async fn call(
    tools: &ToolRegistry,
    session: &AgentSession,
    id: &str,
    args: Value,
) -> noemori_agent::ToolResult {
    tools
        .execute_in_session(
            &ToolCall {
                id: id.into(),
                name: "browser".into(),
                arguments: args,
            },
            ExecutionContext::new(CancellationToken::new(), Duration::from_secs(30)).unwrap(),
            session,
        )
        .await
        .unwrap()
}

fn target(result: &noemori_agent::ToolResult, label: &str) -> (String, String, String) {
    let observation = &result.output["observation"];
    let element = observation["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|element| element["description"].as_str().unwrap().contains(label))
        .unwrap();
    (
        observation["page"].as_str().unwrap().into(),
        observation["id"].as_str().unwrap().into(),
        element["ref"].as_str().unwrap().into(),
    )
}

#[tokio::test]
async fn oversized_batch_is_rejected_without_discarding_the_browser() {
    let root = tempfile::tempdir().unwrap();
    let (url, server) = site().await;
    let mut tools = ToolRegistry::new();
    tools.register(tool(root.path(), url.clone())).unwrap();
    let session = AgentSession::new();
    let opened = call(&tools, &session, "open", json!({"action":"open","url":url})).await;
    let (page, observation, reference) = target(&opened, "姓名");
    let steps: Vec<_> = (0..5)
        .map(|_| json!({"action":"fill","ref":reference,"text":"😀".repeat(65536)}))
        .collect();
    let result = tools.execute_in_session(
        &ToolCall { id: "large".into(), name: "browser".into(), arguments: json!({"action":"batch","page":page,"observation":observation,"steps":steps}) },
        ExecutionContext::new(CancellationToken::new(), Duration::from_secs(30)).unwrap(),
        &session,
    ).await;
    let after = tools
        .execute_in_session(
            &ToolCall {
                id: "after-large".into(),
                name: "browser".into(),
                arguments: json!({"action":"tabs"}),
            },
            ExecutionContext::new(CancellationToken::new(), Duration::from_secs(30)).unwrap(),
            &session,
        )
        .await;
    let snapshot = session.browser_snapshot();
    // 先结算资源再断言，回归重新出现时也不能因测试 panic 留下浏览器或临时数据。
    let cleanup = session.close().await;
    server.abort();
    cleanup.unwrap();
    let result = result.unwrap();
    let after = after.unwrap();
    assert!(result.is_error);
    assert!(result.output.to_string().contains("1 MiB"));
    assert_eq!(after.output["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(
        after.output["tabs"][0]["id"],
        opened.output["tabs"][0]["id"]
    );
    assert_eq!(snapshot.status, BrowserStatus::Ready);
}

#[tokio::test]
async fn browser_state_survives_turns_and_closes_with_its_session() {
    let root = tempfile::tempdir().unwrap();
    let (url, server) = site().await;
    let mut tools = ToolRegistry::new();
    tools.register(tool(root.path(), url.clone())).unwrap();
    let session = AgentSession::new();
    let first = call(&tools, &session, "open", json!({"action":"open","url":url})).await;
    assert_eq!(first.output["outcome"], "executed", "{:?}", first.output);
    let (page, observation, reference) = target(&first, "姓名");
    let filled = call(&tools, &session, "fill", json!({"action":"fill","page":page,"observation":observation,"ref":reference,"text":"跨轮用户"})).await;
    let (page, observation, reference) = target(&filled, "姓名");
    let focused = call(
        &tools,
        &session,
        "end",
        json!({"action":"press","page":page,"observation":observation,"ref":reference,"key":"End"}),
    )
    .await;
    let (page, observation, reference) = target(&focused, "姓名");
    let typed = call(&tools, &session, "type", json!({"action":"type","page":page,"observation":observation,"ref":reference,"text":"追加"})).await;
    assert_eq!(typed.output["outcome"], "executed");
    let (page, observation, reference) = target(&typed, "保存");
    let saved = call(
        &tools,
        &session,
        "save",
        json!({"action":"click","page":page,"observation":observation,"ref":reference}),
    )
    .await;
    assert_eq!(saved.output["outcome"], "executed");
    assert!(
        saved.output["observation"]["text"]
            .as_str()
            .unwrap()
            .contains("跨轮用户追加")
    );
    let image = call(
        &tools,
        &session,
        "image",
        json!({"action":"screenshot","page":page}),
    )
    .await;
    assert_eq!(image.media.len(), 1);
    assert!(image.output.get("image").is_none());
    assert_eq!(session.browser_snapshot().tabs.len(), 1);
    session.close().await.unwrap();
    assert_eq!(session.browser_snapshot().status, BrowserStatus::Closed);
    assert!(session.browser_snapshot().tabs.is_empty());
    server.abort();
}

#[tokio::test]
async fn browser_sessions_cannot_use_each_others_tabs_and_duplicate_calls_do_not_reopen() {
    let root = tempfile::tempdir().unwrap();
    let (url, server) = site().await;
    let mut tools = ToolRegistry::new();
    tools.register(tool(root.path(), url.clone())).unwrap();
    let first = AgentSession::new();
    let second = AgentSession::new();
    let args = json!({"action":"open","url":url});
    let opened = call(&tools, &first, "open", args.clone()).await;
    call(&tools, &first, "open", args).await;
    assert_eq!(first.browser_snapshot().tabs.len(), 1);
    let result = call(
        &tools,
        &second,
        "foreign",
        json!({"action":"observe","page":opened.output["tabs"][0]["id"]}),
    )
    .await;
    assert_eq!(result.output["outcome"], "not_executed");
    first.close().await.unwrap();
    second.close().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn model_cannot_resume_a_browser_taken_over_by_the_user() {
    let root = tempfile::tempdir().unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(tool(root.path(), "http://127.0.0.1".into()))
        .unwrap();
    let session = AgentSession::new();
    let result = call(&tools, &session, "resume", json!({"action":"resume"})).await;
    assert!(result.is_error);
    assert_eq!(session.browser_snapshot().status, BrowserStatus::Idle);
}

#[tokio::test]
async fn cancellation_keeps_the_browser_and_records_the_late_result() {
    let root = tempfile::tempdir().unwrap();
    let (url, server) = site().await;
    let mut tools = ToolRegistry::new();
    tools.register(tool(root.path(), url.clone())).unwrap();
    let session = AgentSession::new();
    let opened = call(&tools, &session, "open", json!({"action":"open","url":url})).await;
    let page = opened.output["tabs"][0]["id"].clone();
    let cancel = CancellationToken::new();
    let context = ExecutionContext::new(cancel.clone(), Duration::from_secs(2)).unwrap();
    let running = {
        let tools = tools.clone();
        let session = session.clone();
        tokio::spawn(async move {
            tools.execute_in_session(&ToolCall { id: "waiting".into(), name: "browser".into(), arguments: json!({"action":"wait","page":page,"text":"永远不会出现","state":"visible"}) }, context, &session).await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while session.browser_snapshot().status != BrowserStatus::Busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    assert!(matches!(
        running.await.unwrap(),
        Err(noemori_agent::Error::Cancelled)
    ));
    let result = call(&tools, &session, "after-cancel", json!({"action":"tabs"})).await;
    assert_eq!(result.output["tabs"].as_array().unwrap().len(), 1);
    assert!(
        result.output["recent_operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|receipt| receipt["call_id"] == "waiting")
    );
    session.close().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn closing_during_a_browser_wait_reaps_resources_and_rejects_new_work() {
    let root = tempfile::tempdir().unwrap();
    let (url, server) = site().await;
    let mut tools = ToolRegistry::new();
    tools.register(tool(root.path(), url.clone())).unwrap();
    let session = AgentSession::new();
    let opened = call(&tools, &session, "open", json!({"action":"open","url":url})).await;
    let page = opened.output["tabs"][0]["id"].clone();
    let running = {
        let tools = tools.clone();
        let session = session.clone();
        tokio::spawn(async move {
            tools.execute_in_session(&ToolCall { id: "waiting".into(), name: "browser".into(), arguments: json!({"action":"wait","page":page,"text":"等待关闭","state":"visible"}) }, ExecutionContext::new(CancellationToken::new(), Duration::from_secs(30)).unwrap(), &session).await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while session.browser_snapshot().status != BrowserStatus::Busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), session.close())
        .await
        .unwrap()
        .unwrap();
    assert!(running.await.unwrap().is_err());
    assert_eq!(session.browser_snapshot().status, BrowserStatus::Closed);
    assert!(session.browser_snapshot().tabs.is_empty());
    server.abort();
}

#[tokio::test]
async fn nonvisual_model_receives_a_recoverable_error_before_a_screenshot_is_taken() {
    let root = tempfile::tempdir().unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(tool(root.path(), "http://127.0.0.1".into()).with_vision(false))
        .unwrap();
    let session = AgentSession::new();
    let result = call(
        &tools,
        &session,
        "image",
        json!({"action":"screenshot","page":"missing"}),
    )
    .await;
    assert!(result.is_error);
    assert!(
        result.output["error"]
            .as_str()
            .unwrap()
            .contains("图像能力")
    );
    assert_eq!(session.browser_snapshot().status, BrowserStatus::Idle);
}

#[tokio::test]
async fn batch_steps_reach_the_browser_and_remain_in_session_receipts() {
    let root = tempfile::tempdir().unwrap();
    let (url, server) = site().await;
    let mut tools = ToolRegistry::new();
    tools.register(tool(root.path(), url.clone())).unwrap();
    let session = AgentSession::new();
    let opened = call(&tools, &session, "open", json!({"action":"open","url":url})).await;
    let (page, observation, name) = target(&opened, "姓名");
    let (_, _, save) = target(&opened, "保存");
    let result = call(&tools, &session, "batch", json!({"action":"batch","page":page,"observation":observation,"steps":[{"action":"fill","ref":name,"text":"批量验收"},{"action":"click","ref":save}]})).await;
    assert_eq!(result.output["outcome"], "executed", "{:?}", result.output);
    assert_eq!(result.output["steps"].as_array().unwrap().len(), 2);
    assert!(
        result.output["observation"]["text"]
            .as_str()
            .unwrap()
            .contains("批量验收")
    );
    let receipts = session.browser_snapshot().receipts;
    assert_eq!(receipts.last().unwrap().steps.len(), 2);
    let invalid = call(&tools, &session, "forbidden-batch", json!({"action":"batch","page":page,"observation":observation,"steps":[{"action":"allow_origin","origin":"http://localhost:1"}]})).await;
    assert!(invalid.is_error);
    session.close().await.unwrap();
    server.abort();
}
