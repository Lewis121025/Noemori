use super::*;

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
