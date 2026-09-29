use super::*;

#[tokio::test]
async fn bedrock_stream_checks_frames_and_finishes_after_metadata() {
    let events = [
        ("messageStart", json!({"role":"assistant"})),
        (
            "contentBlockDelta",
            json!({"contentBlockIndex":0,"delta":{"text":"你好"}}),
        ),
        ("contentBlockStop", json!({"contentBlockIndex":0})),
        ("messageStop", json!({"stopReason":"end_turn"})),
        (
            "metadata",
            json!({"usage":{"inputTokens":3,"outputTokens":2}}),
        ),
    ];
    let mut server = Server::start(vec![bedrock_fixture(&events)]).await;
    let model = HttpModel::new(config(Protocol::Bedrock, &server.url, true)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    assert_eq!(response.message.text_content(), "你好");
    assert_eq!(response.usage.output_tokens, Some(2));
    server.finish().await;
    let mut damaged = bedrock_fixture(&events);
    *damaged.body.last_mut().unwrap() ^= 1;
    let mut server = Server::start(vec![damaged]).await;
    let model = HttpModel::new(config(Protocol::Bedrock, &server.url, true)).unwrap();
    assert!(matches!(
        generate(&model, request(), context()).await,
        Err(Error::Protocol(_))
    ));
    server.finish().await;
}

#[tokio::test]
async fn aws_sigv4_signs_the_final_body_and_session_credentials() {
    use nous_agent::llm::{AwsCredentials, AwsSigV4};
    let body = json!({"output":{"message":{"content":[{"text":"ok"}]}},"stopReason":"end_turn"});
    let mut server = Server::start(vec![Fixture::json(body)]).await;
    let mut settings = config(Protocol::Bedrock, &server.url, false);
    settings.authentication = Authentication::Dynamic(Arc::new(
        AwsSigV4::new(
            "us-east-1",
            AwsCredentials::new(
                "test-key",
                "test-secret",
                Some("test-session".into()),
                None,
                "test",
            ),
        )
        .unwrap(),
    ));
    let model = HttpModel::new(settings).unwrap();
    generate(&model, request(), context()).await.unwrap();
    server.finish().await;
    let requests = server.requests.lock().unwrap();
    let head = requests[0].head.to_ascii_lowercase();
    assert!(head.contains("authorization: aws4-hmac-sha256"));
    assert!(head.contains("/us-east-1/bedrock/aws4_request"));
    assert!(head.contains("x-amz-security-token: test-session"));
    assert!(!head.contains("test-secret"));
}

#[tokio::test]
async fn bedrock_tool_arguments_and_result_keep_the_native_call_id() {
    let fixture = bedrock_fixture(&[
        ("messageStart", json!({"role":"assistant"})),
        (
            "contentBlockStart",
            json!({"contentBlockIndex":0,"start":{"toolUse":{"toolUseId":"native-a","name":"double"}}}),
        ),
        (
            "contentBlockDelta",
            json!({"contentBlockIndex":0,"delta":{"toolUse":{"input":"{\"value\":"}}}),
        ),
        (
            "contentBlockDelta",
            json!({"contentBlockIndex":0,"delta":{"toolUse":{"input":"2}"}}}),
        ),
        ("contentBlockStop", json!({"contentBlockIndex":0})),
        ("messageStop", json!({"stopReason":"tool_use"})),
    ]);
    let final_fixture = bedrock_fixture(&[
        ("messageStart", json!({"role":"assistant"})),
        (
            "contentBlockDelta",
            json!({"contentBlockIndex":0,"delta":{"text":"4"}}),
        ),
        ("contentBlockStop", json!({"contentBlockIndex":0})),
        ("messageStop", json!({"stopReason":"end_turn"})),
    ]);
    let mut server = Server::start(vec![fixture, final_fixture]).await;
    let model = HttpModel::new(config(Protocol::Bedrock, &server.url, true)).unwrap();
    let response = generate(&model, request(), context()).await.unwrap();
    assert_eq!(
        response.message.tool_calls().next().unwrap().arguments,
        json!({"value":2})
    );
    let mut next = request();
    next.messages.push(response.message);
    next.messages.push(Message::tool_results(vec![ToolResult {
        call_id: "native-a".into(),
        name: "double".into(),
        output: json!(4),
        is_error: false,
    }]));
    generate(&model, next, context()).await.unwrap();
    server.finish().await;
    assert_eq!(
        server.requests.lock().unwrap()[1].body["messages"][2]["content"][0]["toolResult"]["toolUseId"],
        "native-a"
    );
}
