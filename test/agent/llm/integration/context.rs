use super::*;

#[tokio::test]
async fn native_chat_and_ollama_replay_only_conversation_fields() {
    for protocol in [Protocol::OpenAiChat, Protocol::Ollama] {
        let mut raw = json!({
            "role":"assistant", "content":"计算", "id":"message-internal",
            "created_at":"now", "status":"completed", "usage":{"tokens":9},
            "logprobs":{"token":"noise"}, "trace_id":"trace-internal",
            "tool_calls":[{"id":"call-1", "index":0, "type":"function",
                "function":{"name":"lookup", "arguments":{"id":"business-1"}}}]
        });
        if protocol == Protocol::OpenAiChat {
            raw["tool_calls"][0]["function"]["arguments"] =
                json!(json!({"id":"business-1"}).to_string());
            raw["reasoning_content"] = json!("推理");
            raw["reasoning_details"] =
                json!([{"type":"reasoning.encrypted", "id":"reasoning-1", "data":"signed"}]);
        } else {
            raw["thinking"] = json!("推理");
        }
        let first_body = if protocol == Protocol::OpenAiChat {
            json!({"id":"response-1", "choices":[{"message":raw,
                "finish_reason":"tool_calls"}]})
        } else {
            json!({"message":raw, "done":true, "done_reason":"stop"})
        };
        let final_body = if protocol == Protocol::OpenAiChat {
            chat("完成")
        } else {
            json!({"message":{"content":"完成"}, "done":true})
        };
        let mut server =
            Server::start(vec![Fixture::json(first_body), Fixture::json(final_body)]).await;
        let model = HttpModel::new(config(protocol, &server.url, false)).unwrap();
        let first = generate(&model, request(), context()).await.unwrap();
        let call_id = first.message.tool_calls().next().unwrap().id.clone();
        let original = first
            .message
            .provider_data
            .as_ref()
            .unwrap()
            .payload()
            .clone();
        assert_eq!(original["id"], "message-internal");
        let mut next = request();
        next.messages.push(first.message);
        next.messages.push(Message::tool_results(vec![ToolResult {
            call_id: call_id.clone(),
            name: "lookup".into(),
            output: json!({"id":"business-1", "title":"笔记"}),
            is_error: false,
            media: Vec::new(),
        }]));
        let retained = next.messages[2].clone();
        generate(&model, next, context()).await.unwrap();
        assert_eq!(
            retained.provider_data.as_ref().unwrap().payload(),
            &original
        );
        server.finish().await;
        let requests = server.requests.lock().unwrap();
        let replay = &requests[1].body["messages"][2];
        for field in [
            "id",
            "created_at",
            "status",
            "usage",
            "logprobs",
            "trace_id",
        ] {
            assert!(replay.get(field).is_none(), "{protocol:?}: {field}");
        }
        assert_eq!(replay["content"], "计算");
        assert!(replay["tool_calls"][0].get("index").is_none());
        let arguments = &replay["tool_calls"][0]["function"]["arguments"];
        if protocol == Protocol::OpenAiChat {
            assert_eq!(replay["tool_calls"][0]["id"], call_id);
            assert_eq!(requests[1].body["messages"][3]["tool_call_id"], call_id);
            assert_eq!(
                serde_json::from_str::<Value>(arguments.as_str().unwrap()).unwrap()["id"],
                "business-1"
            );
            assert_eq!(replay["reasoning_content"], "推理");
            assert_eq!(replay["reasoning_details"], original["reasoning_details"]);
        } else {
            assert!(replay["tool_calls"][0].get("id").is_none());
            assert!(replay["tool_calls"][0].get("type").is_none());
            assert_eq!(arguments["id"], "business-1");
            assert_eq!(replay["thinking"], "推理");
        }
        let output: Value =
            serde_json::from_str(requests[1].body["messages"][3]["content"].as_str().unwrap())
                .unwrap();
        assert_eq!(output["output"]["id"], "business-1");
    }
}

#[tokio::test]
async fn responses_replay_omits_optional_ids_and_keeps_reasoning_and_phase() {
    for streaming in [false, true] {
        let reasoning = json!({"type":"reasoning", "id":"reasoning-1",
            "summary":[], "encrypted_content":"signed"});
        let output = json!([
            reasoning,
            {"type":"message", "id":"message-internal", "status":"completed",
                "role":"assistant", "phase":"commentary", "content":[
                    {"type":"output_text", "text":"计算", "annotations":[], "logprobs":[{"token":"noise"}]},
                    {"type":"refusal", "refusal":"无法执行部分操作"}
                ]},
            {"type":"function_call", "id":"item-internal", "status":"completed",
                "call_id":"call-1", "name":"lookup", "arguments":"{\"id\":\"business-1\"}"}
        ]);
        let first_body = json!({"id":"response-1", "status":"completed", "output":output});
        let final_body = json!({"status":"completed", "output":[
            {"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"完成"}]}
        ]});
        let fixture = |body| {
            if streaming {
                Fixture::sse(
                    vec![json!({"type":"response.completed", "response":body})],
                    false,
                )
            } else {
                Fixture::json(body)
            }
        };
        let mut server = Server::start(vec![fixture(first_body), fixture(final_body)]).await;
        let model =
            HttpModel::new(config(Protocol::OpenAiResponses, &server.url, streaming)).unwrap();
        let first = generate(&model, request(), context()).await.unwrap();
        assert_eq!(first.response_id.as_deref(), Some("response-1"));
        assert_eq!(
            first.message.provider_data.as_ref().unwrap().payload(),
            &output
        );
        let mut next = request();
        next.messages.push(first.message);
        next.messages.push(Message::tool_results(vec![ToolResult {
            call_id: "call-1".into(),
            name: "lookup".into(),
            output: json!({"id":"business-1"}),
            is_error: false,
            media: Vec::new(),
        }]));
        generate(&model, next, context()).await.unwrap();
        server.finish().await;
        let requests = server.requests.lock().unwrap();
        let input = &requests[1].body["input"];
        assert_eq!(input[2], reasoning);
        assert_eq!(
            input[3],
            json!({"role":"assistant", "phase":"commentary", "content":[
                {"type":"input_text", "text":"计算"},
                {"type":"input_text", "text":"无法执行部分操作"}
            ]})
        );
        assert_eq!(
            input[4],
            json!({"type":"function_call", "call_id":"call-1",
            "name":"lookup", "arguments":"{\"id\":\"business-1\"}"})
        );
        assert_eq!(input[5]["call_id"], "call-1");
    }
}

#[tokio::test]
async fn anthropic_tool_results_use_the_protocol_error_flag_without_a_duplicate_wrapper() {
    for is_error in [false, true] {
        let first_body = json!({"content":[{"type":"tool_use", "id":"call-1",
            "name":"lookup", "input":{"id":"business-1"}}], "stop_reason":"tool_use"});
        let final_body =
            json!({"content":[{"type":"text", "text":"完成"}], "stop_reason":"end_turn"});
        let mut server =
            Server::start(vec![Fixture::json(first_body), Fixture::json(final_body)]).await;
        let model = HttpModel::new(config(Protocol::Anthropic, &server.url, false)).unwrap();
        let first = generate(&model, request(), context()).await.unwrap();
        let output = json!({"id":"business-1", "message":"工具结果"});
        let mut next = request();
        next.messages.push(first.message);
        next.messages.push(Message::tool_results(vec![ToolResult {
            call_id: "call-1".into(),
            name: "lookup".into(),
            output: output.clone(),
            is_error,
            media: Vec::new(),
        }]));
        generate(&model, next, context()).await.unwrap();
        server.finish().await;
        let requests = server.requests.lock().unwrap();
        let result = &requests[1].body["messages"][2]["content"][0];
        assert_eq!(result["tool_use_id"], "call-1");
        assert_eq!(result["is_error"], is_error);
        assert_eq!(
            serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap(),
            output
        );
    }
}
