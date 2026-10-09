use super::*;

#[tokio::test]
async fn retryable_http_status_survives_an_oversized_error_body() {
    use noemori_agent::{
        runtime::{Agent, RunInput, RunOptions, RunStatus},
        tool::ToolRegistry,
    };
    let mut server = Server::start(vec![
        Fixture {
            status: 503,
            content_type: "text/plain",
            body: vec![b'x'; 4096],
        },
        Fixture::json(chat("已恢复")),
    ])
    .await;
    let mut settings = config(Protocol::OpenAiChat, &server.url, false);
    settings.max_response_bytes = 256;
    let agent = Agent::new(
        Arc::new(HttpModel::new(settings).unwrap()),
        ToolRegistry::new(),
        RunOptions {
            retry_delay: Duration::ZERO,
            ..Default::default()
        },
    )
    .unwrap();
    let mut messages = request().messages;
    messages.insert(1, Message::text(Role::User, "本轮文章上下文"));
    let report = agent.run(RunInput::new(messages)).await.unwrap();
    assert!(
        matches!(report.status, RunStatus::Completed),
        "{:?}",
        report.status
    );
    assert_eq!(report.model_calls, 2);
    server.finish().await;
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[0].body, requests[1].body);
    assert!(requests[1].body.to_string().contains("本轮文章上下文"));
}

#[tokio::test]
async fn unreadable_http_error_bodies_preserve_status_and_retry_classification() {
    for status in [400, 503] {
        let mut server = Server::start(vec![Fixture {
            status,
            content_type: "text/plain",
            body: vec![b'x'; 4096],
        }])
        .await;
        let mut settings = config(Protocol::OpenAiResponses, &server.url, true);
        settings.max_response_bytes = 256;
        let error = generate(&HttpModel::new(settings).unwrap(), request(), context())
            .await
            .unwrap_err();
        assert!(
            matches!(&error, Error::Http { status: actual, message, .. } if *actual == status && message.contains("错误响应正文读取失败"))
        );
        assert_eq!(error.is_retryable(), status == 503);
        server.finish().await;
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn native_assistant_payloads_cannot_replay_a_different_role() {
    let mut mismatches = Vec::new();
    for protocol in [Protocol::OpenAiChat, Protocol::Ollama] {
        for streaming in [false, true] {
            for role in [None, Some("user")] {
                let mut message = json!({"content":"ok"});
                if let Some(role) = role {
                    message["role"] = json!(role);
                }
                let fixture = match (protocol, streaming) {
                    (Protocol::OpenAiChat, true) => {
                        Fixture::sse(vec![chat_chunk(message, json!("stop"))], true)
                    }
                    (Protocol::OpenAiChat, false) => Fixture::json(
                        json!({"choices":[{"message":message,"finish_reason":"stop"}]}),
                    ),
                    _ => Fixture::json(json!({"message":message,"done":true,"done_reason":"stop"})),
                };
                let mut server = Server::start(vec![fixture]).await;
                let model = HttpModel::new(config(protocol, &server.url, streaming)).unwrap();
                let result = generate(&model, request(), context()).await;
                let valid = match (role, result) {
                    (None, Ok(response)) => {
                        response.message.provider_data.unwrap().payload()["role"] == "assistant"
                    }
                    (Some(_), Err(Error::Protocol(_))) => true,
                    _ => false,
                };
                if !valid {
                    mismatches.push((protocol, streaming, role));
                }
                server.finish().await;
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "原生消息角色不符合契约：{mismatches:?}"
    );
}

#[tokio::test]
async fn all_native_protocols_complete_through_real_http_adapters() {
    let cases = vec![
        (Protocol::OpenAiChat, chat("你好")),
        (
            Protocol::OpenAiResponses,
            json!({"id":"r1","status":"completed","output":[{"type":"message","id":"msg1","role":"assistant","content":[{"type":"output_text","text":"你好"}]}],"usage":{"input_tokens":3,"output_tokens":2}}),
        ),
        (
            Protocol::Anthropic,
            json!({"id":"m1","content":[{"type":"text","text":"你好"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}),
        ),
        (
            Protocol::Gemini,
            json!({"responseId":"r1","candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}),
        ),
        (
            Protocol::Ollama,
            json!({"created_at":"now","message":{"role":"assistant","content":"你好"},"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":2}),
        ),
        (
            Protocol::Bedrock,
            json!({"output":{"message":{"role":"assistant","content":[{"text":"你好"}]}},"stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":2}}),
        ),
    ];
    for (protocol, body) in cases {
        let mut server = Server::start(vec![Fixture::json(body)]).await;
        let model = HttpModel::new(config(protocol, &server.url, false)).unwrap();
        let mut input = request();
        input.options.temperature = Some(0.5);
        input.options.top_p = Some(0.8);
        input.options.max_output_tokens = Some(99);
        let response = generate(&model, input, context()).await.unwrap();
        assert_eq!(response.message.text_content(), "你好", "{protocol:?}");
        assert_eq!(response.finish_reason, FinishReason::Stop);
        assert_eq!(response.usage.input_tokens, Some(3));
        assert_eq!(response.usage.output_tokens, Some(2));
        server.finish().await;
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let body = &requests[0].body;
        let (options, top_p, max_tokens) = match protocol {
            Protocol::Gemini => (&body["generationConfig"], "topP", "maxOutputTokens"),
            Protocol::Ollama => (&body["options"], "top_p", "num_predict"),
            Protocol::Bedrock => (&body["inferenceConfig"], "topP", "maxTokens"),
            Protocol::OpenAiChat => (body, "top_p", "max_completion_tokens"),
            Protocol::OpenAiResponses => (body, "top_p", "max_output_tokens"),
            Protocol::Anthropic | Protocol::VertexAnthropic => (body, "top_p", "max_tokens"),
        };
        assert_eq!(options["temperature"], 0.5);
        assert_eq!(options[top_p], 0.8);
        assert_eq!(options[max_tokens], 99);
        if matches!(protocol, Protocol::Gemini | Protocol::Bedrock) {
            assert!(requests[0].body.get("stream").is_none());
        } else {
            assert_eq!(requests[0].body["stream"], false);
        }
    }
}

#[tokio::test]
async fn eof_without_protocol_terminal_is_rejected() {
    let cases = vec![
        (
            Protocol::OpenAiChat,
            Fixture::sse(
                vec![chat_chunk(json!({"content":"部分"}), json!("stop"))],
                false,
            ),
        ),
        (
            Protocol::OpenAiResponses,
            Fixture::sse(
                vec![json!({"type":"response.output_text.delta","delta":"部分"})],
                false,
            ),
        ),
        (
            Protocol::Anthropic,
            Fixture::sse(
                vec![json!({"type":"message_start","message":{"id":"m1","content":[],"usage":{}}})],
                false,
            ),
        ),
        (
            Protocol::Gemini,
            Fixture::sse(
                vec![json!({"candidates":[{"content":{"parts":[{"text":"部分"}]}}]})],
                false,
            ),
        ),
        (
            Protocol::Ollama,
            Fixture {
                status: 200,
                content_type: "application/x-ndjson",
                body: json!({"message":{"content":"部分"},"done":false})
                    .to_string()
                    .into_bytes(),
            },
        ),
    ];
    for (protocol, fixture) in cases {
        let mut server = Server::start(vec![fixture]).await;
        let model = HttpModel::new(config(protocol, &server.url, true)).unwrap();
        assert!(
            matches!(
                generate(&model, request(), context()).await,
                Err(Error::Protocol(_))
            ),
            "{protocol:?}"
        );
        server.finish().await;
    }
}

#[tokio::test]
async fn custom_auth_and_http_errors_are_preserved() {
    let mut server = Server::start(vec![Fixture {
        status: 429,
        content_type: "application/json",
        body: json!({"error":"limit"}).to_string().into_bytes(),
    }])
    .await;
    let mut settings = config(Protocol::OpenAiChat, &server.url, false);
    settings.authentication = Authentication::Header {
        name: "api-key".into(),
        value: "test-secret".into(),
    };
    assert!(!format!("{:?}", settings.authentication).contains("test-secret"));
    let model = HttpModel::new(settings).unwrap();
    let error = generate(&model, request(), context()).await.unwrap_err();
    assert!(error.is_retryable());
    assert!(matches!(error, Error::Http { status: 429, .. }));
    server.finish().await;
    assert!(
        server.requests.lock().unwrap()[0]
            .head
            .to_ascii_lowercase()
            .contains("api-key: test-secret")
    );
}

#[tokio::test]
async fn core_fields_cannot_be_overridden_by_provider_options() {
    let model = HttpModel::new(config(Protocol::OpenAiChat, "http://127.0.0.1:1", false)).unwrap();
    for key in ["messages", "model", "tools", "stream", "n"] {
        let mut request = request();
        request
            .options
            .provider_options
            .insert(key.into(), json!("override"));
        assert!(matches!(
            generate(&model, request, context()).await,
            Err(Error::Config(_))
        ));
    }
}

#[tokio::test]
async fn model_adapters_work_inside_the_agent_loop() {
    use noemori_agent::{
        runtime::{Agent, RunInput, RunOptions, RunStatus},
        tool::ToolRegistry,
    };
    let mut server = Server::start(vec![Fixture::sse(
        vec![chat_chunk(json!({"content":"你好"}), json!("stop"))],
        true,
    )])
    .await;
    let model = Arc::new(HttpModel::new(config(Protocol::OpenAiChat, &server.url, true)).unwrap());
    let agent = Agent::new(model, ToolRegistry::new(), RunOptions::default()).unwrap();
    let report = agent.run(RunInput::new(request().messages)).await.unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    server.finish().await;
}

#[tokio::test]
async fn local_call_ids_are_unique_across_responses_without_native_ids() {
    let cases = [
        (
            Protocol::Gemini,
            json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"double","args":{"value":2}}}]},"finishReason":"STOP"}]}),
        ),
        (
            Protocol::Ollama,
            json!({"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"double","arguments":{"value":2}}}]},"done":true}),
        ),
    ];
    for (protocol, body) in cases {
        let mut server =
            Server::start(vec![Fixture::json(body.clone()), Fixture::json(body)]).await;
        let model = HttpModel::new(config(protocol, &server.url, false)).unwrap();
        let first = generate(&model, request(), context()).await.unwrap();
        let second = generate(&model, request(), context()).await.unwrap();
        assert_ne!(
            first.message.tool_calls().next().unwrap().id,
            second.message.tool_calls().next().unwrap().id,
            "{protocol:?}"
        );
        server.finish().await;
    }
}

#[tokio::test]
async fn empty_success_is_not_a_completed_response() {
    let mut server = Server::start(vec![Fixture::json(chat(""))]).await;
    let model = HttpModel::new(config(Protocol::OpenAiChat, &server.url, false)).unwrap();
    assert!(matches!(
        generate(&model, request(), context()).await,
        Err(Error::Protocol(_))
    ));
    server.finish().await;
}

#[tokio::test]
async fn editing_a_message_cannot_silently_replay_stale_native_content() {
    let mut server = Server::start(vec![Fixture::json(chat("original"))]).await;
    let model = HttpModel::new(config(Protocol::OpenAiChat, &server.url, false)).unwrap();
    let mut response = generate(&model, request(), context()).await.unwrap();
    server.finish().await;
    response.message.content = vec![noemori_agent::ContentPart::Text("edited".into())];
    let mut next = request();
    next.messages.push(response.message);
    assert!(matches!(
        generate(&model, next, context()).await,
        Err(Error::Config(_))
    ));
}

#[tokio::test]
async fn provider_specific_options_extend_nested_generation_settings() {
    let body = json!({"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]});
    let mut server = Server::start(vec![Fixture::json(body)]).await;
    let model = HttpModel::new(config(Protocol::Gemini, &server.url, false)).unwrap();
    let mut input = request();
    input.options.temperature = Some(0.4);
    input.options.provider_options.insert(
        "generationConfig".into(),
        json!({"thinkingConfig":{"thinkingBudget":1024}}),
    );
    generate(&model, input, context()).await.unwrap();
    server.finish().await;
    {
        let captured = server.requests.lock().unwrap();
        assert_eq!(captured[0].body["generationConfig"]["temperature"], 0.4);
        assert_eq!(
            captured[0].body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            1024
        );
    }
    let mut input = request();
    input
        .options
        .provider_options
        .insert("generationConfig".into(), json!({"candidateCount":2}));
    assert!(matches!(
        generate(&model, input, context()).await,
        Err(Error::Config(_))
    ));
}

#[tokio::test]
async fn legacy_chat_and_vertex_anthropic_use_their_actual_wire_fields() {
    let mut server = Server::start(vec![Fixture::json(chat("ok"))]).await;
    let mut settings = config(Protocol::OpenAiChat, &server.url, false);
    settings.chat_token_limit = noemori_agent::llm::ChatTokenLimit::MaxTokens;
    let model = HttpModel::new(settings).unwrap();
    let mut input = request();
    input.options.max_output_tokens = Some(99);
    generate(&model, input, context()).await.unwrap();
    server.finish().await;
    assert_eq!(server.requests.lock().unwrap()[0].body["max_tokens"], 99);
    assert!(
        server.requests.lock().unwrap()[0]
            .body
            .get("max_completion_tokens")
            .is_none()
    );
    let body = json!({"id":"m1","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{}});
    let mut server = Server::start(vec![Fixture::json(body)]).await;
    let model = HttpModel::new(config(Protocol::VertexAnthropic, &server.url, false)).unwrap();
    generate(&model, request(), context()).await.unwrap();
    server.finish().await;
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[0].body["anthropic_version"], "vertex-2023-10-16");
    assert!(requests[0].body.get("model").is_none());
}

#[tokio::test]
async fn cross_provider_history_and_oversized_responses_are_rejected() {
    let mut server = Server::start(vec![Fixture::json(chat("original"))]).await;
    let model = HttpModel::new(config(Protocol::OpenAiChat, &server.url, false)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    server.finish().await;
    let other = HttpModel::new(config(Protocol::Anthropic, "http://127.0.0.1:1", false)).unwrap();
    let mut next = request();
    next.messages.push(response.message);
    assert!(matches!(
        generate(&other, next, context()).await,
        Err(Error::Unsupported(_))
    ));
    let mut server = Server::start(vec![Fixture::json(chat("too long"))]).await;
    let mut settings = config(Protocol::OpenAiChat, &server.url, false);
    settings.max_response_bytes = 10;
    let model = HttpModel::new(settings).unwrap();
    assert!(matches!(
        generate(&model, request(), context()).await,
        Err(Error::Protocol(_))
    ));
    server.finish().await;
}

#[tokio::test]
async fn native_streams_keep_truncated_arguments_as_pending_deltas() {
    use noemori_agent::{
        runtime::{Agent, RunInput, RunOptions, RunStatus},
        tool::ToolRegistry,
    };
    let anthropic = Fixture::sse(
        vec![
            json!({"type":"message_start","message":{"id":"m1","content":[],"usage":{}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"double","input":{}}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"}}),
            json!({"type":"message_stop"}),
        ],
        false,
    );
    let bedrock = bedrock_fixture(&[
        ("messageStart", json!({"role":"assistant"})),
        (
            "contentBlockStart",
            json!({"contentBlockIndex":0,"start":{"toolUse":{"toolUseId":"a","name":"double"}}}),
        ),
        (
            "contentBlockDelta",
            json!({"contentBlockIndex":0,"delta":{"toolUse":{"input":"{"}}}),
        ),
        ("contentBlockStop", json!({"contentBlockIndex":0})),
        ("messageStop", json!({"stopReason":"max_tokens"})),
    ]);
    for (protocol, fixture) in [
        (Protocol::Anthropic, anthropic),
        (Protocol::Bedrock, bedrock),
    ] {
        let mut server = Server::start(vec![fixture]).await;
        let model = Arc::new(HttpModel::new(config(protocol, &server.url, true)).unwrap());
        let agent = Agent::new(model, ToolRegistry::new(), RunOptions::default()).unwrap();
        let report = agent.run(RunInput::new(request().messages)).await.unwrap();
        assert!(matches!(report.status, RunStatus::Truncated));
        let pending = report.pending_turn.unwrap();
        assert_eq!(pending.response.unwrap().message.tool_calls().count(), 0);
        assert!(pending.deltas.iter().any(|event|matches!(event,noemori_agent::llm::ModelEvent::ToolCallDelta{arguments,..}if arguments=="{")));
        server.finish().await;
    }
}

#[tokio::test]
async fn generation_content_cannot_follow_a_finish_reason() {
    let cases = [
        (
            Protocol::OpenAiChat,
            Fixture::sse(
                vec![
                    chat_chunk(json!({"content":"完成"}), json!("stop")),
                    chat_chunk(json!({"content":"不应追加"}), Value::Null),
                ],
                true,
            ),
        ),
        (
            Protocol::Gemini,
            Fixture::sse(
                vec![
                    json!({"candidates":[{"content":{"parts":[{"text":"完成"}]},"finishReason":"STOP"}]}),
                    json!({"candidates":[{"content":{"parts":[{"text":"不应追加"}]}}]}),
                ],
                false,
            ),
        ),
    ];
    let mut accepted = Vec::new();
    for (protocol, fixture) in cases {
        let mut server = Server::start(vec![fixture]).await;
        let model = HttpModel::new(config(protocol, &server.url, true)).unwrap();
        if !matches!(
            generate(&model, request(), context()).await,
            Err(Error::Protocol(_))
        ) {
            accepted.push(protocol);
        }
        server.finish().await;
    }
    assert!(accepted.is_empty(), "结束后仍接受内容的协议：{accepted:?}");
}

#[tokio::test]
async fn optional_tool_call_fields_accept_null_but_reject_wrong_types() {
    let mut mismatches = Vec::new();
    for protocol in [Protocol::OpenAiChat, Protocol::Ollama] {
        for field in [Value::Null, json!("invalid-array")] {
            let mut body = match protocol {
                Protocol::OpenAiChat => chat("ok"),
                _ => json!({"message":{"content":"ok"},"done":true,"done_reason":"stop"}),
            };
            let message = if protocol == Protocol::OpenAiChat {
                &mut body["choices"][0]["message"]
            } else {
                &mut body["message"]
            };
            message["tool_calls"] = field.clone();
            let mut server = Server::start(vec![Fixture::json(body)]).await;
            let model = HttpModel::new(config(protocol, &server.url, false)).unwrap();
            let result = generate(&model, request(), context()).await;
            if result.is_ok() != field.is_null() {
                mismatches.push((protocol, field));
            }
            server.finish().await;
        }
    }
    assert!(mismatches.is_empty(), "可选字段处理不一致：{mismatches:?}");
}
