use super::*;

#[tokio::test]
async fn gemini_stream_retains_thought_signature_and_function_id() {
    let events = vec![
        json!({"responseId":"r1","candidates":[{"content":{"parts":[{"functionCall":{"id":"call-1","name":"double","args":{"value":2}},"thoughtSignature":"signed"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}),
    ];
    let final_events = vec![
        json!({"responseId":"r2","candidates":[{"content":{"parts":[{"text":"4"}]},"finishReason":"STOP"}]}),
    ];
    let mut server = Server::start(vec![
        Fixture::sse(events, false),
        Fixture::sse(final_events, false),
    ])
    .await;
    let model = HttpModel::new(config(Protocol::Gemini, &server.url, true)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    assert_eq!(response.finish_reason, FinishReason::ToolCalls);
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
        requests[1].body["contents"][1]["parts"][0]["thoughtSignature"],
        "signed"
    );
    assert_eq!(
        requests[1].body["contents"][2]["parts"][0]["functionResponse"]["id"],
        "call-1"
    );
    assert!(requests[0].head.contains("alt=sse"));
}

#[tokio::test]
async fn gemini_native_call_ids_are_not_classified_by_a_magic_prefix() {
    let response = json!({"candidates":[{"content":{"parts":[{"functionCall":{"id":"nous-gemini-real","name":"double","args":{"value":2}}}]},"finishReason":"STOP"}]});
    let final_response =
        json!({"candidates":[{"content":{"parts":[{"text":"4"}]},"finishReason":"STOP"}]});
    let mut server =
        Server::start(vec![Fixture::json(response), Fixture::json(final_response)]).await;
    let model = HttpModel::new(config(Protocol::Gemini, &server.url, false)).unwrap();
    let first = generate(&model, request(), context()).await.unwrap();
    let mut second = request();
    second.messages.push(first.message);
    second.messages.push(Message::tool_results(vec![ToolResult {
        call_id: "nous-gemini-real".into(),
        name: "double".into(),
        output: json!(4),
        is_error: false,
    }]));
    generate(&model, second, context()).await.unwrap();
    server.finish().await;
    assert_eq!(
        server.requests.lock().unwrap()[1].body["contents"][2]["parts"][0]["functionResponse"]["id"],
        "nous-gemini-real"
    );
}

#[tokio::test]
async fn blocked_gemini_response_retains_the_actual_response_id() {
    let fixture = Fixture::json(
        json!({"responseId":"response-42","promptFeedback":{"blockReason":"SAFETY"}}),
    );
    let mut server = Server::start(vec![fixture]).await;
    let model = HttpModel::new(config(Protocol::Gemini, &server.url, false)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    assert_eq!(response.finish_reason, FinishReason::ContentFilter);
    assert_eq!(response.response_id.as_deref(), Some("response-42"));
    server.finish().await;
}
