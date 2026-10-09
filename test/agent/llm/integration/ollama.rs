use super::*;

#[tokio::test]
async fn ollama_effort_maps_to_think_without_aliasing_selected_levels() {
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
            Some("true"),
            Some("false"),
        ] {
            let response = json!({"message":{"role":"assistant","content":"完成"},"done":true,"done_reason":"stop"});
            let fixture = if streaming {
                Fixture {
                    status: 200,
                    content_type: "application/x-ndjson",
                    body: format!("{response}\n").into_bytes(),
                }
            } else {
                Fixture::json(response)
            };
            let mut server = Server::start(vec![fixture]).await;
            let mut selected = config(Protocol::Ollama, &server.url, streaming);
            selected.reasoning_effort = effort
                .map(|value| serde_json::from_value::<ReasoningEffort>(json!(value)).unwrap());
            generate(&HttpModel::new(selected).unwrap(), request(), context())
                .await
                .unwrap();
            server.finish().await;
            let requests = server.requests.lock().unwrap();
            let expected = effort.map(|value| match value {
                "none" | "false" => json!(false),
                "true" => json!(true),
                _ => json!(value),
            });
            assert_eq!(requests[0].body.get("think"), expected.as_ref());
        }
    }
}

#[tokio::test]
async fn ollama_unsupported_effort_reports_the_gateway_error() {
    use noemori_agent::llm::ReasoningEffort;
    let mut server = Server::start(vec![Fixture {
        status: 400,
        content_type: "application/json",
        body: br#"{"error":"unsupported think level: max"}"#.to_vec(),
    }])
    .await;
    let mut selected = config(Protocol::Ollama, &server.url, false);
    selected.reasoning_effort = Some(ReasoningEffort::Max);
    let error = generate(&HttpModel::new(selected).unwrap(), request(), context())
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::Http { status: 400, ref message, .. } if message.contains("unsupported think level: max"))
    );
    server.finish().await;
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].body["think"], "max");
}

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
