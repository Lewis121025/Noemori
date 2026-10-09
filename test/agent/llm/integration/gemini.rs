use super::*;

#[tokio::test]
async fn gemini_effort_maps_to_thinking_config_without_downgrading_values() {
    use noemori_agent::llm::ReasoningEffort;
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
            let response = json!({"candidates":[{"content":{"parts":[{"text":"完成"}]},"finishReason":"STOP"}]});
            let fixture = if streaming {
                Fixture::sse(vec![response], false)
            } else {
                Fixture::json(response)
            };
            let mut server = Server::start(vec![fixture]).await;
            let mut selected = config(Protocol::Gemini, &server.url, streaming);
            selected.reasoning_effort = effort
                .map(|value| serde_json::from_value::<ReasoningEffort>(json!(value)).unwrap());
            let mut input = request();
            input.options.temperature = Some(0.5);
            generate(&HttpModel::new(selected).unwrap(), input, context())
                .await
                .unwrap();
            server.finish().await;
            let requests = server.requests.lock().unwrap();
            let body = &requests[0].body;
            assert_eq!(body["generationConfig"]["temperature"], 0.5);
            let expected = effort.map(|value| {
                if value == "none" {
                    json!({"thinkingBudget": 0})
                } else {
                    json!({"thinkingLevel": value.to_ascii_uppercase()})
                }
            });
            assert_eq!(
                body.pointer("/generationConfig/thinkingConfig"),
                expected.as_ref()
            );
        }
    }
}

#[tokio::test]
async fn gemini_25_uses_the_official_reasoning_effort_budget_mapping() {
    use noemori_agent::llm::ReasoningEffort;
    for model_id in ["gemini-2.5-flash", "models/gemini-2.5-pro"] {
        for (effort, budget) in [
            (None, None),
            (Some("none"), Some(0)),
            (Some("minimal"), Some(1024)),
            (Some("low"), Some(1024)),
            (Some("medium"), Some(8192)),
            (Some("high"), Some(24576)),
        ] {
            let mut server = Server::start(vec![Fixture::json(json!({"candidates":[{"content":{"parts":[{"text":"完成"}]},"finishReason":"STOP"}]}))]).await;
            let mut selected = config(Protocol::Gemini, &server.url, false);
            selected.model = model_id.into();
            selected.reasoning_effort = effort
                .map(|value| serde_json::from_value::<ReasoningEffort>(json!(value)).unwrap());
            generate(&HttpModel::new(selected).unwrap(), request(), context())
                .await
                .unwrap();
            server.finish().await;
            let requests = server.requests.lock().unwrap();
            assert_eq!(
                requests[0].body.pointer("/generationConfig/thinkingConfig"),
                budget.map(|value| json!({"thinkingBudget":value})).as_ref()
            );
        }
    }
}

#[tokio::test]
async fn gemini_unsupported_effort_reports_the_gateway_error() {
    use noemori_agent::llm::ReasoningEffort;
    let mut server = Server::start(vec![Fixture {
        status: 400,
        content_type: "application/json",
        body: br#"{"error":{"message":"unsupported thinkingLevel: XHIGH"}}"#.to_vec(),
    }])
    .await;
    let mut selected = config(Protocol::Gemini, &server.url, false);
    selected.reasoning_effort = Some(ReasoningEffort::Xhigh);
    let error = generate(&HttpModel::new(selected).unwrap(), request(), context())
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::Http { status: 400, ref message, .. } if message.contains("unsupported thinkingLevel: XHIGH"))
    );
    server.finish().await;
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "XHIGH"
    );
}

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
        media: Vec::new(),
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
    let response = json!({"candidates":[{"content":{"parts":[{"functionCall":{"id":"noemori-gemini-real","name":"double","args":{"value":2}}}]},"finishReason":"STOP"}]});
    let final_response =
        json!({"candidates":[{"content":{"parts":[{"text":"4"}]},"finishReason":"STOP"}]});
    let mut server =
        Server::start(vec![Fixture::json(response), Fixture::json(final_response)]).await;
    let model = HttpModel::new(config(Protocol::Gemini, &server.url, false)).unwrap();
    let first = generate(&model, request(), context()).await.unwrap();
    let mut second = request();
    second.messages.push(first.message);
    second.messages.push(Message::tool_results(vec![ToolResult {
        call_id: "noemori-gemini-real".into(),
        name: "double".into(),
        output: json!(4),
        is_error: false,
        media: Vec::new(),
    }]));
    generate(&model, second, context()).await.unwrap();
    server.finish().await;
    assert_eq!(
        server.requests.lock().unwrap()[1].body["contents"][2]["parts"][0]["functionResponse"]["id"],
        "noemori-gemini-real"
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
