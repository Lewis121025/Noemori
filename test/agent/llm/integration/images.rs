use super::*;
use noemori_agent::{ContentPart, Image, ImageFormat, ToolCall};

pub(super) fn image() -> Image {
    use base64::{Engine, engine::general_purpose::STANDARD};
    Image::new(ImageFormat::Png, STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=").unwrap()).unwrap()
}

pub(super) fn response_body(protocol: Protocol) -> Value {
    match protocol {
        Protocol::OpenAiChat => chat("看到了图片"),
        Protocol::OpenAiResponses => {
            json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"看到了图片"}]}]})
        }
        Protocol::Anthropic | Protocol::VertexAnthropic => {
            json!({"content":[{"type":"text","text":"看到了图片"}],"stop_reason":"end_turn"})
        }
        Protocol::Gemini => {
            json!({"candidates":[{"content":{"parts":[{"text":"看到了图片"}]},"finishReason":"STOP"}]})
        }
        Protocol::Ollama => json!({"message":{"content":"看到了图片"},"done":true}),
        Protocol::Bedrock => {
            json!({"output":{"message":{"content":[{"text":"看到了图片"}]}},"stopReason":"end_turn"})
        }
    }
}

#[tokio::test]
async fn every_protocol_sends_user_and_tool_images_as_native_image_content() {
    for protocol in [
        Protocol::OpenAiChat,
        Protocol::OpenAiResponses,
        Protocol::Anthropic,
        Protocol::VertexAnthropic,
        Protocol::Gemini,
        Protocol::Ollama,
        Protocol::Bedrock,
    ] {
        let mut server = Server::start(vec![Fixture::json(response_body(protocol))]).await;
        let mut settings = config(protocol, &server.url, false);
        settings.capabilities.vision = true;
        let model = HttpModel::new(settings).unwrap();
        let mut input = request();
        input.messages[1].content.push(ContentPart::Image(image()));
        input.messages.push(Message {
            role: Role::Assistant,
            provider_data: None,
            content: vec![ContentPart::ToolCall(ToolCall {
                id: "call-1".into(),
                name: "web".into(),
                arguments: json!({"type":"fetch","url":"https://example.com/paper.pdf"}),
            })],
        });
        input.messages.push(Message::tool_results(vec![ToolResult {
            call_id: "call-1".into(),
            name: "web".into(),
            output: json!({"pages":[1]}),
            is_error: false,
            media: vec![noemori_agent::Media::Image(image())],
        }]));
        generate(&model, input, context()).await.unwrap();
        server.finish().await;
        let requests = server.requests.lock().unwrap();
        let body = &requests[0].body;
        let encoded = image().base64();
        let data_url = image().data_url();
        match protocol {
            Protocol::OpenAiChat => {
                assert_eq!(
                    body["messages"][1]["content"][1]["image_url"]["url"],
                    data_url
                );
                assert_eq!(body["messages"][3]["tool_call_id"], "call-1");
                assert_eq!(
                    body["messages"][4]["content"][1]["image_url"]["url"],
                    data_url
                );
            }
            Protocol::OpenAiResponses => {
                assert_eq!(body["input"][2]["content"][0]["image_url"], data_url);
                assert_eq!(body["input"][4]["output"][1]["image_url"], data_url);
                assert_eq!(body["input"][4]["call_id"], "call-1");
            }
            Protocol::Anthropic | Protocol::VertexAnthropic => {
                assert_eq!(body["messages"][0]["content"][1]["source"]["data"], encoded);
                assert_eq!(
                    body["messages"][2]["content"][0]["content"][1]["source"]["data"],
                    encoded
                );
                assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "call-1");
            }
            Protocol::Gemini => {
                assert_eq!(
                    body["contents"][0]["parts"][1]["inlineData"]["data"],
                    encoded
                );
                assert_eq!(
                    body["contents"][2]["parts"][2]["inlineData"]["data"],
                    encoded
                );
                assert_eq!(
                    body["contents"][2]["parts"][0]["functionResponse"]["id"],
                    "call-1"
                );
            }
            Protocol::Ollama => {
                assert_eq!(body["messages"][1]["images"][0], encoded);
                assert_eq!(body["messages"][3]["tool_name"], "web");
                assert_eq!(body["messages"][4]["images"][0], encoded);
            }
            Protocol::Bedrock => {
                assert_eq!(
                    body["messages"][0]["content"][1]["image"]["source"]["bytes"],
                    encoded
                );
                assert_eq!(
                    body["messages"][2]["content"][0]["toolResult"]["content"][1]["image"]["source"]
                        ["bytes"],
                    encoded
                );
                assert_eq!(
                    body["messages"][2]["content"][0]["toolResult"]["toolUseId"],
                    "call-1"
                );
            }
        }
    }
}

#[tokio::test]
async fn vision_must_be_explicit_and_tool_json_never_contains_image_bytes() {
    let model = HttpModel::new(config(Protocol::OpenAiChat, "http://127.0.0.1:1", false)).unwrap();
    let mut input = request();
    input.messages[1].content.push(ContentPart::Image(image()));
    assert!(matches!(
        generate(&model, input, context()).await,
        Err(Error::Unsupported(_))
    ));
    assert!(!format!("{:?}", image()).contains(&image().base64()));
}

#[tokio::test]
async fn image_supplements_wait_until_split_tool_result_groups_are_closed() {
    for protocol in [Protocol::OpenAiChat, Protocol::Ollama] {
        let mut server = Server::start(vec![Fixture::json(response_body(protocol))]).await;
        let mut settings = config(protocol, &server.url, false);
        settings.capabilities.vision = true;
        let model = HttpModel::new(settings).unwrap();
        let mut input = request();
        input.messages.push(Message {
            role: Role::Assistant,
            provider_data: None,
            content: ["a", "b"]
                .into_iter()
                .map(|id| {
                    ContentPart::ToolCall(ToolCall {
                        id: id.into(),
                        name: "web".into(),
                        arguments: json!({}),
                    })
                })
                .collect(),
        });
        for id in ["a", "b"] {
            input.messages.push(Message::tool_results(vec![ToolResult {
                call_id: id.into(),
                name: "web".into(),
                output: json!({"title":id}),
                is_error: false,
                media: vec![noemori_agent::Media::Image(image())],
            }]));
        }
        generate(&model, input, context()).await.unwrap();
        server.finish().await;
        let requests = server.requests.lock().unwrap();
        let roles: Vec<_> = requests[0].body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value["role"].as_str().unwrap())
            .collect();
        assert_eq!(
            roles,
            [
                "system",
                "user",
                "assistant",
                "tool",
                "tool",
                "user",
                "user"
            ]
        );
    }
}

#[tokio::test]
async fn bedrock_rejects_oversized_images_before_network_io() {
    let mut settings = config(Protocol::Bedrock, "http://127.0.0.1:1", false);
    settings.capabilities.vision = true;
    let model = HttpModel::new(settings).unwrap();
    let mut data = image().data().to_vec();
    data.resize(4 * 1024 * 1024, 0);
    let large = Image::new(ImageFormat::Png, data).unwrap();
    let mut input = request();
    input.messages[1].content.push(ContentPart::Image(large));
    let result = generate(&model, input, context()).await;
    assert!(
        matches!(&result,Err(Error::Config(reason)) if reason.contains("Bedrock") && reason.contains("3.75")),
        "{result:?}"
    );
}

#[tokio::test]
async fn bedrock_rejects_too_many_images_in_one_message_before_network_io() {
    let mut settings = config(Protocol::Bedrock, "http://127.0.0.1:1", false);
    settings.capabilities.vision = true;
    let model = HttpModel::new(settings).unwrap();
    let mut input = request();
    input.messages[1]
        .content
        .extend((0..21).map(|_| ContentPart::Image(image())));
    let result = generate(&model, input, context()).await;
    assert!(
        matches!(&result,Err(Error::Config(reason)) if reason.contains("Bedrock") && reason.contains("20")),
        "{result:?}"
    );
}

#[tokio::test]
async fn bedrock_accepts_the_image_count_boundary() {
    let mut server = Server::start(vec![Fixture::json(response_body(Protocol::Bedrock))]).await;
    let mut settings = config(Protocol::Bedrock, &server.url, false);
    settings.capabilities.vision = true;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let model = HttpModel::with_client(settings, client).unwrap();
    let mut input = request();
    input.messages[1]
        .content
        .extend((0..20).map(|_| ContentPart::Image(image())));
    generate(&model, input, context()).await.unwrap();
    server.finish().await;
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}
