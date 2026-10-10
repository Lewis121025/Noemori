use super::*;

/// 异常角色必须在原始报文仍可见时拒绝，不能先改成模型角色再通过统一校验。
#[tokio::test]
async fn every_protocol_rejects_explicitly_invalid_reply_roles() {
    let mut accepted = Vec::new();
    for (protocol, _) in fixtures::PROTOCOLS {
        for streaming in [false, true] {
            let wrong_model_role = if protocol == Protocol::Gemini {
                "assistant"
            } else {
                "model"
            };
            for role in [
                json!("user"),
                json!("system"),
                json!(wrong_model_role),
                json!(7),
                json!(true),
            ] {
                let mut server =
                    Server::start(vec![role_fixture(protocol, streaming, role.clone())]).await;
                let model = HttpModel::new(config(protocol, &server.url, streaming)).unwrap();
                if !matches!(
                    generate(&model, request(), context()).await,
                    Err(Error::Protocol(_))
                ) {
                    accepted.push((protocol, streaming, role));
                }
                server.finish().await;
            }
        }
    }
    assert!(accepted.is_empty(), "错误角色被当成模型回复：{accepted:?}");
}

#[tokio::test]
async fn every_protocol_accepts_its_native_model_role_and_compatible_null_roles() {
    for (protocol, _) in fixtures::PROTOCOLS {
        for streaming in [false, true] {
            let expected = if protocol == Protocol::Gemini {
                "model"
            } else {
                "assistant"
            };
            for role in [json!(expected), Value::Null] {
                // Bedrock 流的 messageStart 必须声明角色，保持现有严格帧契约。
                if protocol == Protocol::Bedrock && streaming && role.is_null() {
                    continue;
                }
                let mut server = Server::start(vec![role_fixture(protocol, streaming, role)]).await;
                let model = HttpModel::new(config(protocol, &server.url, streaming)).unwrap();
                assert_eq!(
                    generate(&model, request(), context())
                        .await
                        .unwrap()
                        .message
                        .text_content(),
                    "ok"
                );
                server.finish().await;
            }
        }
    }
}

/// 解码和保存历史后的回放必须拒绝同一批非法核心字段，且回放校验不发送请求。
#[tokio::test]
async fn responses_decode_and_replay_share_the_output_contract() {
    use noemori_agent::{ContentPart, ProviderData, llm::Model};
    let invalid_items = [
        json!({"type":"message", "role":"user", "content":[{"type":"output_text", "text":"历史"}]}),
        json!({"type":"message", "role":"assistant", "content":[{"type":"input_text", "text":"历史"}]}),
        json!({"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":7}]}),
        json!({"type":"function_call", "call_id":"lookup-id", "name":"lookup", "arguments":{}}),
    ];
    for item in invalid_items {
        let mut server = Server::start(vec![Fixture::json(
            json!({"status":"completed", "output":[item]}),
        )])
        .await;
        let model = HttpModel::new(config(Protocol::OpenAiResponses, &server.url, false)).unwrap();
        assert!(matches!(
            generate(&model, request(), context()).await,
            Err(Error::Protocol(_) | Error::Unsupported(_))
        ));
        server.finish().await;
        let content = vec![ContentPart::Text("历史".into())];
        let mut next = request();
        next.messages.push(Message {
            role: Role::Assistant,
            provider_data: Some(ProviderData::new(
                "openai-responses",
                "test-model",
                json!([item]),
                &content,
            )),
            content,
        });
        let saved = serde_json::to_vec(&next.messages).unwrap();
        next.messages = serde_json::from_slice(&saved).unwrap();
        assert!(matches!(
            model.validate_request(&next),
            Err(Error::Protocol(_) | Error::Unsupported(_))
        ));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn responses_replay_preserves_native_fields_after_saving_and_restoring() {
    for streaming in [false, true] {
        let content = json!([
            {"type":"output_text", "text":"查询", "annotations":[],
                "logprobs":[{"token":"查询"}], "provider_text_signature":"text-signed"},
            {"type":"refusal", "refusal":"部分操作不可用", "provider_refusal_signature":"refusal-signed"}
        ]);
        let output = json!([
            {"type":"reasoning", "id":"reasoning-id", "summary":[{"type":"summary_text", "text":"检查"}],
                "encrypted_content":"reasoning-signed", "provider_reasoning_state":{"id":"keep"}},
            {"type":"message", "role":"assistant", "id":"message-id", "status":"completed",
                "phase":"commentary", "encrypted_content":"message-signed", "content":content,
                "provider_message_state":{"id":"keep"}},
            {"type":"function_call", "id":"item-id", "status":"completed", "call_id":"lookup-id",
                "name":"lookup", "arguments":"{\"id\":\"business-id\"}", "namespace":"notes",
                "encrypted_content":"call-signed", "encrypted_function_args":["args-signed"],
                "provider_call_state":{"id":"keep"}}
        ]);
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
        let mut server = Server::start(vec![
            fixture(json!({"status":"completed", "output":output})),
            fixture(
                json!({"status":"completed", "output":[{"type":"message", "role":"assistant",
                "content":[{"type":"output_text", "text":"完成"}]}]}),
            ),
        ])
        .await;
        let model =
            HttpModel::new(config(Protocol::OpenAiResponses, &server.url, streaming)).unwrap();
        let response = generate(&model, request(), context()).await.unwrap();
        let saved = serde_json::to_vec(&response.message).unwrap();
        let restored: Message = serde_json::from_slice(&saved).unwrap();
        assert_eq!(restored.provider_data.as_ref().unwrap().payload(), &output);
        let mut next = request();
        next.messages.push(restored);
        next.messages.push(Message::tool_results(vec![ToolResult {
            call_id: "lookup-id".into(),
            name: "lookup".into(),
            output: json!({"id":"business-id"}),
            is_error: false,
            media: Vec::new(),
        }]));
        generate(&model, next, context()).await.unwrap();
        server.finish().await;
        let requests = server.requests.lock().unwrap();
        let input = &requests[1].body["input"];
        assert_eq!(input[2], output[0]);
        assert_eq!(input[3]["content"], content);
        assert_eq!(input[3]["phase"], "commentary");
        assert_eq!(input[3]["encrypted_content"], "message-signed");
        assert_eq!(input[3]["provider_message_state"], json!({"id":"keep"}));
        assert_eq!(input[4]["call_id"], "lookup-id");
        assert_eq!(input[4]["encrypted_content"], "call-signed");
        assert_eq!(input[4]["encrypted_function_args"], json!(["args-signed"]));
        assert_eq!(input[4]["provider_call_state"], json!({"id":"keep"}));
        for item in [&input[3], &input[4]] {
            assert!(item.get("id").is_none());
            assert!(item.get("status").is_none());
        }
        assert_eq!(input[5]["call_id"], "lookup-id");
    }
}

fn role_fixture(protocol: Protocol, streaming: bool, role: Value) -> Fixture {
    let body = match protocol {
        Protocol::OpenAiChat => {
            json!({"choices":[{"message":{"role":role,"content":"ok"},"finish_reason":"stop"}]})
        }
        Protocol::OpenAiResponses => {
            json!({"status":"completed","output":[{"type":"message","role":role,"content":[{"type":"output_text","text":"ok"}]}]})
        }
        Protocol::Anthropic | Protocol::VertexAnthropic => {
            json!({"role":role,"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"})
        }
        Protocol::Gemini => {
            json!({"candidates":[{"content":{"role":role,"parts":[{"text":"ok"}]},"finishReason":"STOP"}]})
        }
        Protocol::Ollama => {
            json!({"message":{"role":role,"content":"ok"},"done":true,"done_reason":"stop"})
        }
        Protocol::Bedrock => {
            json!({"output":{"message":{"role":role,"content":[{"text":"ok"}]}},"stopReason":"end_turn"})
        }
    };
    if !streaming {
        return Fixture::json(body);
    }
    match protocol {
        Protocol::OpenAiChat => Fixture::sse(
            vec![chat_chunk(
                body["choices"][0]["message"].clone(),
                json!("stop"),
            )],
            true,
        ),
        Protocol::OpenAiResponses => Fixture::sse(
            vec![json!({"type":"response.completed","response":body})],
            false,
        ),
        Protocol::Anthropic | Protocol::VertexAnthropic => Fixture::sse(
            vec![
                json!({"type":"message_start","message":{"role":role,"content":[],"usage":{}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                json!({"type":"message_stop"}),
            ],
            false,
        ),
        Protocol::Gemini => Fixture::sse(vec![body], false),
        Protocol::Ollama => Fixture {
            status: 200,
            content_type: "application/x-ndjson",
            body: format!("{body}\n").into_bytes(),
        },
        Protocol::Bedrock => bedrock_fixture(&[
            ("messageStart", json!({"role":role})),
            (
                "contentBlockDelta",
                json!({"contentBlockIndex":0,"delta":{"text":"ok"}}),
            ),
            ("contentBlockStop", json!({"contentBlockIndex":0})),
            ("messageStop", json!({"stopReason":"end_turn"})),
            ("metadata", json!({"usage":{}})),
        ]),
    }
}
