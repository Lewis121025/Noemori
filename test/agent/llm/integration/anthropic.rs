use super::*;

#[tokio::test]
async fn anthropic_stream_requires_closed_blocks_and_retains_thinking_signature() {
    let events = vec![
        json!({"type":"message_start","message":{"id":"m1","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推理"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"double","input":{}}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"value\":2}"}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}),
        json!({"type":"message_stop"}),
    ];
    let final_events = vec![
        json!({"type":"message_start","message":{"id":"m2","content":[],"usage":{"input_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"4"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
        json!({"type":"message_stop"}),
    ];
    let mut server = Server::start(vec![
        Fixture::sse(events, false),
        Fixture::sse(final_events, false),
    ])
    .await;
    let model = HttpModel::new(config(Protocol::Anthropic, &server.url, true)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    assert_eq!(response.usage.input_tokens, Some(5));
    assert_eq!(response.usage.output_tokens, Some(9));
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
        requests[1].body["messages"][1]["content"][0]["signature"],
        "signed"
    );
}

#[tokio::test]
async fn malformed_anthropic_blocks_return_errors_instead_of_panicking() {
    let events = vec![
        json!({"type":"message_start","message":{"id":"m1","content":[],"usage":{}}}),
        json!({"type":"content_block_start","index":0,"content_block":"invalid"}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bad"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        json!({"type":"message_stop"}),
    ];
    let mut server = Server::start(vec![Fixture::sse(events, false)]).await;
    let model = HttpModel::new(config(Protocol::Anthropic, &server.url, true)).unwrap();
    assert!(matches!(
        generate(&model, request(), context()).await,
        Err(Error::Protocol(_))
    ));
    server.finish().await;
}
