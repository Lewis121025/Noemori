use super::*;

#[tokio::test]
async fn bedrock_effort_uses_the_official_model_family_field() {
    use noemori_agent::llm::ReasoningEffort;
    for (model_id, field) in [
        ("anthropic.claude-opus-4-6-v1", "claude"),
        ("us.anthropic.claude-opus-4-6-v1", "claude"),
        ("global.anthropic.claude-opus-4-6-v1", "claude"),
        (
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6-v1",
            "claude",
        ),
        (
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1",
            "claude",
        ),
        ("openai.gpt-oss-120b-1:0", "openai"),
        ("amazon.nova-2-lite-v1:0", "nova"),
        ("us.amazon.nova-2-lite-v1:0", "nova"),
        ("custom-model", "openai"),
    ] {
        for streaming in [false, true] {
            for effort in [
                None,
                Some("none"),
                Some("minimal"),
                Some("low"),
                Some("medium"),
                Some("high"),
                Some("xhigh"),
                Some("max"),
                Some("ULTRA"),
            ] {
                let fixture = if streaming {
                    bedrock_fixture(&[
                        ("messageStart", json!({"role":"assistant"})),
                        (
                            "contentBlockDelta",
                            json!({"contentBlockIndex":0,"delta":{"text":"完成"}}),
                        ),
                        ("contentBlockStop", json!({"contentBlockIndex":0})),
                        ("messageStop", json!({"stopReason":"end_turn"})),
                        (
                            "metadata",
                            json!({"usage":{"inputTokens":1,"outputTokens":1}}),
                        ),
                    ])
                } else {
                    Fixture::json(
                        json!({"output":{"message":{"role":"assistant","content":[{"text":"完成"}]}},"stopReason":"end_turn"}),
                    )
                };
                let mut server = Server::start(vec![fixture]).await;
                let mut selected = config(Protocol::Bedrock, &server.url, streaming);
                selected.model = model_id.into();
                selected.reasoning_effort = effort
                    .map(|value| serde_json::from_value::<ReasoningEffort>(json!(value)).unwrap());
                generate(&HttpModel::new(selected).unwrap(), request(), context())
                    .await
                    .unwrap();
                server.finish().await;
                let requests = server.requests.lock().unwrap();
                let expected = effort.map(|value| match field {
                    "claude" if value == "none" => json!({"thinking":{"type":"disabled"}}),
                    "claude" => json!({"output_config":{"effort":value}}),
                    "nova" if value == "none" => json!({"reasoningConfig":{"type":"disabled"}}),
                    "nova" => {
                        json!({"reasoningConfig":{"type":"enabled","maxReasoningEffort":value}})
                    }
                    _ => json!({"reasoning_effort":value}),
                });
                assert_eq!(
                    requests[0].body.get("additionalModelRequestFields"),
                    expected.as_ref(),
                    "{model_id} streaming={streaming}"
                );
            }
        }
    }
}

#[tokio::test]
async fn bedrock_effort_preserves_other_official_additional_fields() {
    use noemori_agent::llm::ReasoningEffort;
    let mut server = Server::start(vec![Fixture::json(json!({"output":{"message":{"role":"assistant","content":[{"text":"完成"}]}},"stopReason":"end_turn"}))]).await;
    let mut selected = config(Protocol::Bedrock, &server.url, false);
    selected.model = "anthropic.claude-opus-4-6-v1".into();
    selected.reasoning_effort = Some(ReasoningEffort::High);
    let mut input = request();
    input.options.provider_options.insert(
        "additionalModelRequestFields".into(),
        json!({"thinking":{"type":"adaptive"}}),
    );
    generate(&HttpModel::new(selected).unwrap(), input, context())
        .await
        .unwrap();
    server.finish().await;
    assert_eq!(
        server.requests.lock().unwrap()[0].body["additionalModelRequestFields"],
        json!({"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}})
    );
}

#[tokio::test]
async fn bedrock_unsupported_effort_reports_the_gateway_error() {
    use noemori_agent::llm::ReasoningEffort;
    let mut server = Server::start(vec![Fixture {
        status: 400,
        content_type: "application/json",
        body: br#"{"message":"unsupported effort: max"}"#.to_vec(),
    }])
    .await;
    let mut selected = config(Protocol::Bedrock, &server.url, false);
    selected.model = "openai.gpt-oss-120b-1:0".into();
    selected.reasoning_effort = Some(ReasoningEffort::Max);
    let error = generate(&HttpModel::new(selected).unwrap(), request(), context())
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::Http { status: 400, ref message, .. } if message.contains("unsupported effort: max"))
    );
    server.finish().await;
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].body["additionalModelRequestFields"]["reasoning_effort"],
        "max"
    );
}

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
    use noemori_agent::llm::{AwsCredentials, AwsSigV4};
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
        media: Vec::new(),
    }]));
    generate(&model, next, context()).await.unwrap();
    server.finish().await;
    assert_eq!(
        server.requests.lock().unwrap()[1].body["messages"][2]["content"][0]["toolResult"]["toolUseId"],
        "native-a"
    );
}
