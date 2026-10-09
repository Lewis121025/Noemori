use super::*;

#[tokio::test]
async fn streaming_requests_accept_complete_json_responses_declared_by_the_server() {
    let cases = [
        (Protocol::OpenAiChat, chat("完成")),
        (
            Protocol::OpenAiResponses,
            json!({"id":"r1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}],"usage":{"input_tokens":3,"output_tokens":2}}),
        ),
    ];
    for (protocol, body) in cases {
        for content_type in [
            "application/json; charset=utf-8",
            "Application/JSON",
            "application/vnd.gateway+json",
        ] {
            let mut fixture = Fixture::json(body.clone());
            fixture.content_type = content_type;
            let mut server = Server::start(vec![fixture]).await;
            let model = HttpModel::new(config(protocol, &server.url, true)).unwrap();
            let response = generate(&model, request(), context()).await.unwrap();
            assert_eq!(response.message.text_content(), "完成");
            assert_eq!(response.finish_reason, FinishReason::Stop);
            assert_eq!(response.usage.input_tokens, Some(3));
            assert_eq!(response.usage.output_tokens, Some(2));
            server.finish().await;
            assert_eq!(server.requests.lock().unwrap()[0].body["stream"], true);
        }
    }
}

#[tokio::test]
async fn streaming_json_responses_preserve_truncation_and_reject_invalid_payloads() {
    let cases = [
        (
            Protocol::OpenAiChat,
            json!({"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"a","type":"function","function":{"name":"double","arguments":"{"}}]},"finish_reason":"length"}]}),
        ),
        (
            Protocol::OpenAiResponses,
            json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"function_call","call_id":"a","name":"double","arguments":"{"}]}),
        ),
    ];
    for (protocol, body) in cases {
        let mut incomplete_json = Fixture::json(body.clone());
        incomplete_json.body.pop();
        let mut server = Server::start(vec![
            Fixture::json(body),
            incomplete_json,
            Fixture::json(json!({"error":{"message":"gateway failure"}})),
        ])
        .await;
        let model = HttpModel::new(config(protocol, &server.url, true)).unwrap();
        let response = generate(&model, request(), context()).await.unwrap();
        assert_eq!(response.finish_reason, FinishReason::Length);
        assert_eq!(response.message.tool_calls().count(), 0);
        for _ in 0..2 {
            assert!(matches!(
                generate(&model, request(), context()).await,
                Err(Error::Protocol(_))
            ));
        }
        server.finish().await;
    }
}

#[test]
fn reasoning_effort_configuration_does_not_prejudge_gateway_support() {
    use noemori_agent::llm::ReasoningEffort;
    for protocol in [
        Protocol::Gemini,
        Protocol::Ollama,
        Protocol::Bedrock,
        Protocol::VertexAnthropic,
    ] {
        let mut settings = config(protocol, "https://example.com/model", false);
        settings.reasoning_effort = Some(ReasoningEffort::High);
        assert!(HttpModel::new(settings).is_ok());
    }
}

#[tokio::test]
async fn openai_effort_reaches_the_matching_request_field_in_json_and_streaming_calls() {
    use noemori_agent::llm::ReasoningEffort;
    for protocol in [Protocol::OpenAiChat, Protocol::OpenAiResponses] {
        for streaming in [false, true] {
            for effort in [
                None,
                Some("high"),
                Some("none"),
                Some("minimal"),
                Some("low"),
                Some("medium"),
                Some("xhigh"),
                Some("max"),
                Some("ULTRA"),
            ] {
                let response = match protocol {
                    Protocol::OpenAiChat => chat("完成"),
                    _ => {
                        json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}]})
                    }
                };
                let fixture = if !streaming {
                    Fixture::json(response)
                } else if protocol == Protocol::OpenAiChat {
                    Fixture::sse(
                        vec![chat_chunk(json!({"content":"完成"}), json!("stop"))],
                        true,
                    )
                } else {
                    Fixture::sse(
                        vec![json!({"type":"response.completed","response":response})],
                        false,
                    )
                };
                let mut server = Server::start(vec![fixture]).await;
                let mut settings = config(protocol, &server.url, streaming);
                settings.reasoning_effort = effort
                    .map(|value| serde_json::from_value::<ReasoningEffort>(json!(value)).unwrap());
                let model = HttpModel::new(settings).unwrap();
                assert_eq!(
                    generate(&model, request(), context())
                        .await
                        .unwrap()
                        .message
                        .text_content(),
                    "完成"
                );
                server.finish().await;
                let requests = server.requests.lock().unwrap();
                let body = &requests[0].body;
                let (pointer, absent) = if protocol == Protocol::OpenAiChat {
                    ("/reasoning_effort", "reasoning")
                } else {
                    ("/reasoning/effort", "reasoning_effort")
                };
                assert_eq!(
                    body.pointer(pointer),
                    effort.map(|value| json!(value)).as_ref(),
                    "{protocol:?} streaming={streaming}"
                );
                assert!(body.get(absent).is_none());
                if effort.is_none() {
                    assert!(body.get("reasoning").is_none());
                }
            }
        }
    }
}

#[tokio::test]
async fn openai_unsupported_effort_reports_the_service_error_without_retry_or_downgrade() {
    use noemori_agent::llm::ReasoningEffort;
    for protocol in [Protocol::OpenAiChat, Protocol::OpenAiResponses] {
        let mut server = Server::start(vec![Fixture {
            status: 400,
            content_type: "application/json",
            body: br#"{"error":{"message":"unsupported reasoning effort: high"}}"#.to_vec(),
        }])
        .await;
        let mut settings = config(protocol, &server.url, false);
        settings.reasoning_effort = Some(ReasoningEffort::High);
        let error = generate(&HttpModel::new(settings).unwrap(), request(), context())
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::Http { status: 400, ref message, .. } if message.contains("unsupported reasoning effort: high"))
        );
        server.finish().await;
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn nullable_tool_delta_fields_preserve_the_existing_call() {
    let events = vec![
        chat_chunk(
            json!({"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"test","arguments":"{}"}}]}),
            Value::Null,
        ),
        chat_chunk(
            json!({"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":null,"arguments":null}}]}),
            json!("tool_calls"),
        ),
    ];
    let mut server = Server::start(vec![Fixture::sse(events, true)]).await;
    let model = HttpModel::new(config(Protocol::OpenAiChat, &server.url, true)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    let call = response.message.tool_calls().next().unwrap();
    assert_eq!(call.id, "call-1");
    assert_eq!(call.arguments, json!({}));
    server.finish().await;
}

#[tokio::test]
async fn chat_stream_assembles_split_tool_arguments_and_keeps_reasoning() {
    let events = vec![
        chat_chunk(
            json!({"role":"assistant","reasoning_content":"先计算"}),
            Value::Null,
        ),
        chat_chunk(
            json!({"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"double","arguments":"{\"value\":"}}]}),
            Value::Null,
        ),
        chat_chunk(
            json!({"tool_calls":[{"index":0,"function":{"arguments":"2}"}}]}),
            Value::Null,
        ),
        chat_chunk(json!({}), json!("tool_calls")),
        json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":8}}),
    ];
    let mut server = Server::start(vec![
        Fixture::sse(events, true),
        Fixture::sse(
            vec![chat_chunk(json!({"content":"4"}), json!("stop"))],
            true,
        ),
    ])
    .await;
    let model = HttpModel::new(config(Protocol::OpenAiChat, &server.url, true)).unwrap();
    let first = generate(&model, request(), context()).await.unwrap();
    let call = first.message.tool_calls().next().unwrap();
    assert_eq!(call.arguments, json!({"value":2}));
    assert_eq!(first.usage.output_tokens, Some(8));
    let result = ToolResult {
        call_id: call.id.clone(),
        name: call.name.clone(),
        output: json!(4),
        is_error: false,
        media: Vec::new(),
    };
    let mut second = request();
    second.messages.push(first.message);
    second.messages.push(Message::tool_results(vec![result]));
    assert_eq!(
        generate(&model, second, context())
            .await
            .unwrap()
            .message
            .text_content(),
        "4"
    );
    server.finish().await;
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests[1].body["messages"][2]["reasoning_content"],
        "先计算"
    );
    assert_eq!(requests[1].body["messages"][3]["tool_call_id"], "call-1");
}

#[tokio::test]
async fn responses_stream_preserves_encrypted_reasoning_items() {
    let output = json!([
        {"type":"reasoning","id":"rs1","summary":[{"type":"summary_text","text":"推理"}],"encrypted_content":"opaque-signature"},
        {"type":"function_call","id":"fc1","call_id":"call-1","name":"double","arguments":"{\"value\":2}","status":"completed"}
    ]);
    let completed = json!({"id":"r1","status":"completed","output":output,"usage":{"input_tokens":1,"output_tokens":2}});
    let final_response = json!({"id":"r2","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"4"}]}]});
    let mut server = Server::start(vec![
        Fixture::sse(
            vec![json!({"type":"response.completed","response":completed})],
            false,
        ),
        Fixture::sse(
            vec![json!({"type":"response.completed","response":final_response})],
            false,
        ),
    ])
    .await;
    let model = HttpModel::new(config(Protocol::OpenAiResponses, &server.url, true)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    let mut second = request();
    second.messages.push(response.message);
    second.messages.push(Message::tool_results(vec![ToolResult {
        call_id: "call-1".into(),
        name: "double".into(),
        output: json!(4),
        is_error: false,
        media: Vec::new(),
    }]));
    generate(&model, second, context()).await.unwrap();
    server.finish().await;
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests[1].body["input"][2]["encrypted_content"],
        "opaque-signature"
    );
    assert_eq!(requests[1].body["input"][4]["type"], "function_call_output");
    assert_eq!(requests[0].body["store"], false);
}

#[tokio::test]
async fn truncated_tool_json_retains_length_reason_without_executable_calls() {
    let cases = [
        (
            Protocol::OpenAiChat,
            json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"a","type":"function","function":{"name":"double","arguments":"{"}}]},"finish_reason":"length"}]}),
        ),
        (
            Protocol::OpenAiResponses,
            json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"function_call","call_id":"a","name":"double","arguments":"{"}]}),
        ),
    ];
    for (protocol, body) in cases {
        let mut server = Server::start(vec![Fixture::json(body)]).await;
        let model = HttpModel::new(config(protocol, &server.url, false)).unwrap();
        let response = generate(&model, request(), context()).await.unwrap();
        assert_eq!(response.finish_reason, FinishReason::Length);
        assert_eq!(response.message.tool_calls().count(), 0);
        server.finish().await;
    }
}

#[tokio::test]
async fn chat_gateway_preserves_the_ordered_reasoning_detail_sequence() {
    let first = json!({"type":"reasoning.text","text":"先推理","index":0,"signature":null});
    let encrypted = json!({"type":"reasoning.encrypted","data":"opaque-data","index":1});
    let last = json!({"type":"reasoning.text","text":"再计算","index":2,"signature":"signed"});
    let events = vec![
        chat_chunk(
            json!({"reasoning_details":[first.clone(),encrypted.clone()]}),
            Value::Null,
        ),
        chat_chunk(json!({"reasoning_details":[last.clone()]}), Value::Null),
        chat_chunk(json!({"content":"答案"}), json!("stop")),
    ];
    let mut server = Server::start(vec![
        Fixture::sse(events, true),
        Fixture::sse(
            vec![chat_chunk(json!({"content":"继续"}), json!("stop"))],
            true,
        ),
    ])
    .await;
    let model = HttpModel::new(config(Protocol::OpenAiChat, &server.url, true)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    let mut next = request();
    next.messages.push(response.message);
    next.messages.push(Message::text(Role::User, "继续"));
    generate(&model, next, context()).await.unwrap();
    server.finish().await;
    assert_eq!(
        server.requests.lock().unwrap()[1].body["messages"][2]["reasoning_details"],
        json!([first, encrypted, last])
    );
}

#[tokio::test]
async fn streaming_chat_rejects_unsupported_tool_call_types() {
    let fixture = Fixture::sse(
        vec![chat_chunk(
            json!({
                "tool_calls":[{"index":0,"id":"call-1","type":"custom","function":{"name":"test","arguments":"{}"}}]
            }),
            json!("tool_calls"),
        )],
        true,
    );
    let mut server = Server::start(vec![fixture]).await;
    let model = HttpModel::new(config(Protocol::OpenAiChat, &server.url, true)).unwrap();
    assert!(matches!(
        generate(&model, request(), context()).await,
        Err(Error::Unsupported(_))
    ));
    server.finish().await;
}
