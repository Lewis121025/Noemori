#![cfg(any(target_os = "macos", target_os = "linux"))]

use super::*;
use noemori_agent::host::{DesktopSession, DesktopSessionOptions, HostRunStatus};

#[tokio::test]
async fn all_protocol_pairs_keep_tools_and_context_when_switching_and_restoring() {
    for (source, source_name) in fixtures::PROTOCOLS {
        for (target, target_name) in fixtures::PROTOCOLS {
            for source_streaming in [false, true] {
                for target_streaming in [false, true] {
                    protocol_pair(source, target, source_streaming, target_streaming)
                        .await
                        .unwrap_or_else(|error| {
                            panic!("{source_name} ({source_streaming}) → {target_name} ({target_streaming}): {error}")
                        });
                }
            }
        }
    }
}

/// 中断节点中的模型响应也属于原连接，迁移后必须闭合未确认工具并移除旧签名。
#[tokio::test]
async fn all_protocol_pairs_resume_pending_tools_without_replaying_uncertain_actions() {
    for (source, source_name) in fixtures::PROTOCOLS {
        for (target, target_name) in fixtures::PROTOCOLS {
            for source_streaming in [false, true] {
                for target_streaming in [false, true] {
                    interrupted_pair(source, target, source_streaming, target_streaming).await
                        .unwrap_or_else(|error| panic!("中断恢复 {source_name} ({source_streaming}) → {target_name} ({target_streaming}): {error}"));
                }
            }
        }
    }
}

async fn interrupted_pair(
    source: Protocol,
    target: Protocol,
    source_streaming: bool,
    target_streaming: bool,
) -> Result<(), Error> {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let fixture = fixtures::fixture(source, false, "source", true);
    let mut body: Value = serde_json::from_slice(&fixture.body).unwrap();
    let arguments = json!({"action":"exec", "cmd":"pwd", "permission_request":{
        "reason":"测试中断恢复的审批节点", "readable_paths":[outside.path()]
    }});
    let expected_arguments = arguments.clone();
    match source {
        Protocol::OpenAiChat => {
            body["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] =
                json!(arguments.to_string())
        }
        Protocol::OpenAiResponses => body["output"][2]["arguments"] = json!(arguments.to_string()),
        Protocol::Anthropic | Protocol::VertexAnthropic => body["content"][2]["input"] = arguments,
        Protocol::Gemini => {
            body["candidates"][0]["content"]["parts"][2]["functionCall"]["args"] = arguments
        }
        Protocol::Ollama => body["message"]["tool_calls"][0]["function"]["arguments"] = arguments,
        Protocol::Bedrock => {
            body["output"]["message"]["content"][2]["toolUse"]["input"] = arguments
        }
    }
    let mut first_server =
        Server::start(vec![fixtures::with_body(source, source_streaming, body)]).await;
    let mut next_server = Server::start(vec![fixtures::fixture(
        target,
        target_streaming,
        "target",
        false,
    )])
    .await;
    let first = Arc::new(HttpModel::new(config(
        source,
        &first_server.url,
        source_streaming,
    ))?);
    let next = Arc::new(HttpModel::new(config(
        target,
        &next_server.url,
        target_streaming,
    ))?);
    let host = DesktopSession::new(
        first.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )?;
    let run = host.start_configured(first, "source-model".into(), "继续原来的任务".into(), None)?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = host.snapshot();
            if !snapshot.approvals.is_empty() {
                return Ok(());
            }
            if snapshot
                .run
                .is_some_and(|run| run.status != HostRunStatus::Running)
            {
                return Err(Error::Protocol("未到达预期工具审批节点".into()));
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| Error::Timeout)??;
    let checkpoint = serde_json::to_string(&host.checkpoint()?).unwrap();
    host.interrupt(&run).await?;
    host.close().await?;
    let restored = DesktopSession::new(
        next.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )?;
    restored.restore(serde_json::from_str(&checkpoint).unwrap())?;
    restored.resume_configured(&run, next, "target-model".into())?;
    completed(&restored).await?;
    assert!(
        restored.snapshot().approvals.is_empty(),
        "未确认工具被重新派发审批"
    );
    restored.checkpoint()?;
    restored.close().await?;
    first_server.finish().await;
    next_server.finish().await;
    let requests = next_server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1, "恢复节点重复请求了模型");
    assert_wire_history(target, &requests[0].body, 1, &expected_arguments);
    let encoded = requests[0].body.to_string();
    for retained in [
        "继续原来的任务",
        "source-回答",
        "source-推理记录",
        "unknown",
    ] {
        assert!(encoded.contains(retained), "{target:?}: 缺少 {retained}");
    }
    assert!(!encoded.contains("source-私有签名"));
    Ok(())
}

async fn protocol_pair(
    source: Protocol,
    target: Protocol,
    source_streaming: bool,
    target_streaming: bool,
) -> Result<(), Error> {
    let root = tempfile::tempdir().unwrap();
    let mut first_server = Server::start(vec![
        fixtures::fixture(source, source_streaming, "source", true),
        fixtures::fixture(source, source_streaming, "source", false),
    ])
    .await;
    let mut next_server = Server::start(vec![
        fixtures::fixture(target, target_streaming, "target", true),
        fixtures::fixture(target, target_streaming, "target", false),
        fixtures::fixture(target, target_streaming, "restored", false),
    ])
    .await;
    let first = Arc::new(HttpModel::new(config(
        source,
        &first_server.url,
        source_streaming,
    ))?);
    let mut selected = config(target, &next_server.url, target_streaming);
    selected.model = "second-model".into();
    let next = Arc::new(HttpModel::new(selected)?);
    let host = DesktopSession::new(
        first.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )?;
    host.start_configured(
        first,
        "source-model".into(),
        "记住切换前的任务".into(),
        None,
    )?;
    completed(&host).await?;
    host.start_configured(
        next.clone(),
        "target-model".into(),
        "切换后继续".into(),
        None,
    )?;
    completed(&host).await?;
    let checkpoint = serde_json::to_string(&host.checkpoint()?).unwrap();
    host.close().await?;
    let restored = DesktopSession::new(
        next.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )?;
    restored.restore(serde_json::from_str(&checkpoint).unwrap())?;
    restored.start_configured(next, "target-model".into(), "恢复后继续".into(), None)?;
    completed(&restored).await?;
    assert_eq!(restored.snapshot().turns.len(), 3);
    restored.close().await?;
    first_server.finish().await;
    next_server.finish().await;
    for (index, request) in first_server.requests.lock().unwrap().iter().enumerate() {
        assert_wire_history(source, &request.body, index, &json!({"action":"list"}));
    }
    for (index, request) in next_server.requests.lock().unwrap().iter().enumerate() {
        assert_wire_history(
            target,
            &request.body,
            1 + index.min(1),
            &json!({"action":"list"}),
        );
        let encoded = request.body.to_string();
        for retained in ["记住切换前的任务", "source-回答", "source-推理记录"] {
            assert!(encoded.contains(retained), "{target:?}: 缺少 {retained}");
        }
        assert!(!encoded.contains("source-私有签名"));
        if index > 0 && target != Protocol::Ollama {
            assert!(
                encoded.contains("target-私有签名"),
                "{target:?}: 原生续轮签名丢失"
            );
        }
    }
    Ok(())
}

async fn completed(host: &DesktopSession) -> Result<(), Error> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(run) = host.snapshot().run {
                if run.status == HostRunStatus::Completed {
                    return Ok(());
                }
                if run.status != HostRunStatus::Running {
                    return Err(Error::Protocol(format!(
                        "{:?}: {:?}",
                        run.status, run.error
                    )));
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| Error::Timeout)?
}

/// 调用与结果共享协议标识，防止跨模型迁移只保留正文而破坏工具闭环。
#[derive(Default)]
struct ToolLinks {
    calls: Vec<Value>,
    results: Vec<Value>,
}

/// 在网络边界检查角色、内容类型和工具关联，避免成功夹具掩盖不合法的请求。
fn assert_wire_history(protocol: Protocol, body: &Value, expected_calls: usize, arguments: &Value) {
    let field = match protocol {
        Protocol::OpenAiResponses => "input",
        Protocol::Gemini => "contents",
        _ => "messages",
    };
    let messages = body[field].as_array().unwrap();
    assert!(!messages.is_empty());
    let mut links = ToolLinks::default();
    for message in messages {
        match protocol {
            Protocol::OpenAiChat | Protocol::Ollama => {
                assert_chat_message(protocol, message, &mut links, arguments)
            }
            Protocol::OpenAiResponses => assert_responses_item(message, &mut links, arguments),
            Protocol::Anthropic | Protocol::VertexAnthropic => {
                assert_anthropic_message(message, &mut links, arguments)
            }
            Protocol::Gemini => assert_gemini_message(message, &mut links, arguments),
            Protocol::Bedrock => assert_bedrock_message(message, &mut links, arguments),
        }
    }
    assert_eq!(
        links.calls, links.results,
        "{protocol:?}: 工具调用与结果的关联被破坏"
    );
    assert_eq!(
        links.calls.len(),
        expected_calls,
        "{protocol:?}: 工具历史丢失"
    );
    assert!(links.calls.iter().all(Value::is_string));
}

fn assert_chat_message(
    protocol: Protocol,
    message: &Value,
    links: &mut ToolLinks,
    arguments: &Value,
) {
    assert!(message["content"].is_string());
    for key in [
        "id",
        "status",
        "usage",
        "created_at",
        "trace_id",
        "logprobs",
    ] {
        assert!(message.get(key).is_none(), "{protocol:?}: {key}");
    }
    if let Some(items) = message["tool_calls"].as_array() {
        for call in items {
            assert_eq!(message["role"], "assistant");
            assert_eq!(call["function"]["name"], "terminal");
            if protocol == Protocol::OpenAiChat {
                assert_eq!(call["type"], "function");
                assert_arguments(&call["function"]["arguments"], arguments);
                links.calls.push(call["id"].clone());
            } else {
                assert_eq!(&call["function"]["arguments"], arguments);
                links.calls.push(call["function"]["name"].clone());
            }
        }
    }
    if message["role"] == "tool" {
        let id = if protocol == Protocol::OpenAiChat {
            "tool_call_id"
        } else {
            "tool_name"
        };
        links.results.push(message[id].clone());
    }
}

fn assert_responses_item(item: &Value, links: &mut ToolLinks, arguments: &Value) {
    match item["type"].as_str() {
        Some("function_call") => {
            assert_eq!(item["name"], "terminal");
            assert_arguments(&item["arguments"], arguments);
            links.calls.push(item["call_id"].clone());
        }
        Some("function_call_output") => links.results.push(item["call_id"].clone()),
        Some("reasoning") => assert!(item["encrypted_content"].is_string()),
        None | Some("message") => {
            if let Some(parts) = item["content"].as_array() {
                for part in parts {
                    let allowed = if item["role"] == "assistant" {
                        ["output_text", "refusal"].as_slice()
                    } else {
                        ["input_text"].as_slice()
                    };
                    assert!(allowed.contains(&part["type"].as_str().unwrap()));
                }
            } else {
                assert!(item["content"].is_string());
            }
        }
        other => panic!("Responses 请求包含不支持的输出项：{other:?}"),
    }
}

fn assert_anthropic_message(message: &Value, links: &mut ToolLinks, arguments: &Value) {
    for part in message["content"].as_array().unwrap() {
        match part["type"].as_str().unwrap() {
            "text" => assert!(part["text"].is_string()),
            "thinking" => assert!(part["signature"].is_string()),
            "tool_use" => {
                assert_eq!(message["role"], "assistant");
                assert_eq!(part["name"], "terminal");
                assert_eq!(&part["input"], arguments);
                links.calls.push(part["id"].clone());
            }
            "tool_result" => {
                assert_eq!(message["role"], "user");
                links.results.push(part["tool_use_id"].clone());
            }
            other => panic!("Anthropic 请求内容类型无效：{other}"),
        }
    }
}

fn assert_gemini_message(message: &Value, links: &mut ToolLinks, arguments: &Value) {
    for part in message["parts"].as_array().unwrap() {
        if let Some(call) = part.get("functionCall") {
            assert_eq!(message["role"], "model");
            assert_eq!(call["name"], "terminal");
            assert_eq!(&call["args"], arguments);
            links.calls.push(call["id"].clone());
        } else if let Some(result) = part.get("functionResponse") {
            assert_eq!(message["role"], "user");
            assert_eq!(result["name"], "terminal");
            links.results.push(result["id"].clone());
        } else {
            assert!(part["text"].is_string());
        }
    }
}

fn assert_bedrock_message(message: &Value, links: &mut ToolLinks, arguments: &Value) {
    for part in message["content"].as_array().unwrap() {
        if let Some(call) = part.get("toolUse") {
            assert_eq!(message["role"], "assistant");
            assert_eq!(call["name"], "terminal");
            assert_eq!(&call["input"], arguments);
            links.calls.push(call["toolUseId"].clone());
        } else if let Some(result) = part.get("toolResult") {
            assert_eq!(message["role"], "user");
            links.results.push(result["toolUseId"].clone());
        } else {
            assert!(part["text"].is_string() || part["reasoningContent"].is_object());
        }
    }
}

fn assert_arguments(arguments: &Value, expected: &Value) {
    assert_eq!(
        &serde_json::from_str::<Value>(arguments.as_str().unwrap()).unwrap(),
        expected
    );
}
