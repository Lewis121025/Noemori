use super::*;

#[tokio::test]
async fn ollama_ndjson_handles_split_utf8_and_terminal_usage() {
    let body=[json!({"message":{"content":"你"},"done":false}),json!({"message":{"content":"好"},"done":false}),json!({"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":2})].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    let mut server = Server::start(vec![Fixture {
        status: 200,
        content_type: "application/x-ndjson",
        body: body.into_bytes(),
    }])
    .await;
    let model = HttpModel::new(config(Protocol::Ollama, &server.url, true)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    assert_eq!(response.message.text_content(), "你好");
    assert_eq!(response.usage.output_tokens, Some(2));
    server.finish().await;
}

#[tokio::test]
async fn ollama_creation_time_is_not_a_provider_response_id() {
    let fixture = Fixture::json(
        json!({"created_at":"2026-09-29T08:00:00Z","message":{"content":"ok"},"done":true,"done_reason":"stop"}),
    );
    let mut server = Server::start(vec![fixture]).await;
    let model = HttpModel::new(config(Protocol::Ollama, &server.url, false)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    assert_eq!(response.response_id, None);
    server.finish().await;
}
