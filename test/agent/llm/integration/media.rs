use super::*;
use noemori_agent::llm::RequestAuthenticator;
use noemori_agent::{
    Audio, AudioFormat, ContentPart, Media, MediaSource, ToolCall, Video, VideoFormat,
};

fn audio(source: MediaSource) -> Audio {
    Audio::new(AudioFormat::Wav, source).unwrap()
}
fn video(source: MediaSource) -> Video {
    Video::new(VideoFormat::Mp4, source).unwrap()
}
fn bytes() -> MediaSource {
    MediaSource::bytes(vec![1, 2, 3, 4]).unwrap()
}
fn settings(protocol: Protocol, url: &str) -> ModelConfig {
    let mut config = config(protocol, url, false);
    config.capabilities.vision = true;
    config.capabilities.audio = true;
    config.capabilities.video = true;
    config
}
fn with_media(media: Vec<Media>, tool: bool) -> ModelRequest {
    let mut input = request();
    if tool {
        input.messages.push(Message {
            role: Role::Assistant,
            provider_data: None,
            content: vec![ContentPart::ToolCall(ToolCall {
                id: "a".into(),
                name: "read".into(),
                arguments: json!({}),
            })],
        });
        input.messages.push(Message::tool_results(vec![ToolResult {
            call_id: "a".into(),
            name: "read".into(),
            output: json!({"summary":"file"}),
            is_error: false,
            media,
        }]));
    } else {
        input.messages[1]
            .content
            .extend(media.into_iter().map(|item| match item {
                Media::Image(value) => ContentPart::Image(value),
                Media::Audio(value) => ContentPart::Audio(value),
                Media::Video(value) => ContentPart::Video(value),
            }));
    }
    input
}
async fn capture(protocol: Protocol, input: ModelRequest) -> Value {
    let mut server = Server::start(vec![Fixture::json(images::response_body(protocol))]).await;
    let model = HttpModel::with_client(
        settings(protocol, &server.url),
        reqwest::Client::builder().no_proxy().build().unwrap(),
    )
    .unwrap();
    generate(&model, input, context()).await.unwrap();
    server.finish().await;
    server.requests.lock().unwrap()[0].body.clone()
}

struct NoAuthentication;
#[async_trait::async_trait]
impl RequestAuthenticator for NoAuthentication {
    async fn authenticate(&self, _: &mut reqwest::Request) -> Result<(), Error> {
        panic!("invalid media must fail before authentication or HTTP");
    }
}
async fn rejected(mut config: ModelConfig, input: ModelRequest, reason: &str) {
    config.authentication = Authentication::Dynamic(Arc::new(NoAuthentication));
    let model = HttpModel::new(config).unwrap();
    let error = generate(&model, input, context()).await.unwrap_err();
    assert!(
        matches!(error, Error::Unsupported(_) | Error::Config(_)),
        "{error}"
    );
    assert!(error.to_string().contains(reason), "{error}");
}

#[tokio::test]
async fn chat_sends_inline_wav_and_mp3_in_user_and_tool_messages() {
    for format in [AudioFormat::Wav, AudioFormat::Mp3] {
        for tool in [false, true] {
            let body = capture(
                Protocol::OpenAiChat,
                with_media(
                    vec![Media::Audio(Audio::new(format, bytes()).unwrap())],
                    tool,
                ),
            )
            .await;
            let index = if tool { 4 } else { 1 };
            assert_eq!(
                body["messages"][index]["content"][1],
                json!({"type":"input_audio","input_audio":{"format":format,"data":"AQIDBA=="}})
            );
            assert!(body.get("modalities").is_none());
            if tool {
                assert_eq!(
                    serde_json::from_str::<Value>(body["messages"][3]["content"].as_str().unwrap())
                        .unwrap(),
                    json!({"is_error":false,"output":{"summary":"file"}})
                );
            }
        }
    }
}

#[tokio::test]
async fn gemini_preserves_mixed_media_order_and_native_references() {
    for source in [
        bytes(),
        MediaSource::Url("https://example.com/media?sig=kept".into()),
        MediaSource::GeminiFile(
            "https://generativelanguage.googleapis.com/v1beta/files/abc".into(),
        ),
        MediaSource::Gcs("gs://bucket/media".into()),
    ] {
        for tool in [false, true] {
            let attachments = vec![
                Media::Image(images::image()),
                Media::Audio(audio(source.clone())),
                Media::Video(video(source.clone())),
            ];
            let body = capture(Protocol::Gemini, with_media(attachments, tool)).await;
            let parts = &body["contents"][if tool { 2 } else { 0 }]["parts"];
            let offset = if tool { 2 } else { 1 };
            assert_eq!(parts[offset]["inlineData"]["mimeType"], "image/png");
            for (index, mime) in [(offset + 1, "audio/wav"), (offset + 2, "video/mp4")] {
                match &source {
                    MediaSource::Bytes(_) => assert_eq!(
                        parts[index],
                        json!({"inlineData":{"mimeType":mime,"data":"AQIDBA=="}})
                    ),
                    MediaSource::Url(uri)
                    | MediaSource::GeminiFile(uri)
                    | MediaSource::Gcs(uri) => assert_eq!(
                        parts[index],
                        json!({"fileData":{"mimeType":mime,"fileUri":uri}})
                    ),
                    _ => unreachable!(),
                }
            }
            if tool {
                assert_eq!(
                    parts[0]["functionResponse"]["response"],
                    json!({"is_error":false,"output":{"summary":"file"}})
                );
            }
        }
    }
}

#[tokio::test]
async fn bedrock_sends_bytes_and_s3_with_tool_audio_outside_the_result() {
    for source in [
        bytes(),
        MediaSource::S3 {
            uri: "s3://bucket/media".into(),
            bucket_owner: None,
        },
        MediaSource::S3 {
            uri: "s3://bucket/media".into(),
            bucket_owner: Some("123456789012".into()),
        },
    ] {
        for tool in [false, true] {
            let body = capture(
                Protocol::Bedrock,
                with_media(
                    vec![
                        Media::Audio(audio(source.clone())),
                        Media::Image(images::image()),
                        Media::Video(video(source.clone())),
                    ],
                    tool,
                ),
            )
            .await;
            let parts = &body["messages"][if tool { 2 } else { 0 }]["content"];
            let offset = if tool { 2 } else { 1 };
            let expected = match &source {
                MediaSource::Bytes(_) => json!({"bytes":"AQIDBA=="}),
                MediaSource::S3 { uri, bucket_owner } => {
                    let mut value = json!({"s3Location":{"uri":uri}});
                    if let Some(owner) = bucket_owner {
                        value["s3Location"]["bucketOwner"] = json!(owner);
                    }
                    value
                }
                _ => unreachable!(),
            };
            assert_eq!(
                parts[offset],
                json!({"audio":{"format":"wav","source":expected}})
            );
            assert!(parts[offset + 1].get("image").is_some());
            assert_eq!(
                parts[offset + 2],
                json!({"video":{"format":"mp4","source":expected}})
            );
            if tool {
                assert_eq!(
                    parts[0]["toolResult"]["content"],
                    json!([{"json":{"summary":"file"}}])
                );
            }
        }
    }
    let body = capture(
        Protocol::Bedrock,
        with_media(vec![Media::Video(video(bytes()))], true),
    )
    .await;
    assert_eq!(
        body["messages"][2]["content"][0]["toolResult"]["content"][1]["video"]["format"],
        "mp4"
    );
}

#[tokio::test]
async fn every_unsupported_protocol_rejects_user_and_tool_audio_video_before_auth() {
    for protocol in [
        Protocol::OpenAiResponses,
        Protocol::Anthropic,
        Protocol::VertexAnthropic,
        Protocol::Ollama,
    ] {
        for media in [Media::Audio(audio(bytes())), Media::Video(video(bytes()))] {
            for tool in [false, true] {
                rejected(
                    settings(protocol, "http://127.0.0.1:1"),
                    with_media(vec![media.clone()], tool),
                    "不支持原生",
                )
                .await;
            }
        }
    }
}

#[tokio::test]
async fn incompatible_sources_and_formats_fail_explicitly_without_network() {
    let url = MediaSource::Url("https://example.com/media?private=secret".into());
    let cases = [
        (Protocol::OpenAiChat, Media::Video(video(bytes())), "视频"),
        (
            Protocol::OpenAiChat,
            Media::Audio(audio(url.clone())),
            "本地字节",
        ),
        (
            Protocol::OpenAiChat,
            Media::Audio(Audio::new(AudioFormat::Flac, bytes()).unwrap()),
            "WAV",
        ),
        (
            Protocol::Gemini,
            Media::Video(Video::new(VideoFormat::Mkv, bytes()).unwrap()),
            "MKV",
        ),
        (
            Protocol::Gemini,
            Media::Audio(audio(MediaSource::S3 {
                uri: "s3://bucket/media".into(),
                bucket_owner: None,
            })),
            "S3",
        ),
        (Protocol::Bedrock, Media::Audio(audio(url)), "S3"),
        (
            Protocol::Bedrock,
            Media::Video(video(MediaSource::Gcs("gs://bucket/media".into()))),
            "S3",
        ),
        (
            Protocol::Bedrock,
            Media::Audio(audio(MediaSource::GeminiFile(
                "https://generativelanguage.googleapis.com/v1beta/files/abc".into(),
            ))),
            "S3",
        ),
        (
            Protocol::Bedrock,
            Media::Audio(Audio::new(AudioFormat::Aiff, bytes()).unwrap()),
            "AIFF",
        ),
        (
            Protocol::Bedrock,
            Media::Video(Video::new(VideoFormat::Avi, bytes()).unwrap()),
            "AVI",
        ),
    ];
    for (protocol, media, reason) in cases {
        for tool in [false, true] {
            rejected(
                settings(protocol, "http://127.0.0.1:1"),
                with_media(vec![media.clone()], tool),
                reason,
            )
            .await;
        }
    }
}

#[tokio::test]
async fn provider_format_aliases_match_the_wire_schema() {
    for (format, mime) in [
        (VideoFormat::Mov, "video/mov"),
        (VideoFormat::Avi, "video/avi"),
        (VideoFormat::Wmv, "video/wmv"),
    ] {
        let body = capture(
            Protocol::Gemini,
            with_media(
                vec![Media::Video(Video::new(format, bytes()).unwrap())],
                false,
            ),
        )
        .await;
        assert_eq!(
            body["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            mime
        );
    }
    let body = capture(
        Protocol::Bedrock,
        with_media(
            vec![Media::Video(
                Video::new(VideoFormat::ThreeGp, bytes()).unwrap(),
            )],
            false,
        ),
    )
    .await;
    assert_eq!(
        body["messages"][0]["content"][1]["video"]["format"],
        "three_gp"
    );
}

#[tokio::test]
async fn split_tool_groups_close_before_audio_supplements() {
    for protocol in [Protocol::OpenAiChat, Protocol::Gemini, Protocol::Bedrock] {
        let mut input = with_media(vec![Media::Audio(audio(bytes()))], true);
        input.messages[2]
            .content
            .push(ContentPart::ToolCall(ToolCall {
                id: "b".into(),
                name: "read".into(),
                arguments: json!({}),
            }));
        input.messages.push(Message::tool_results(vec![ToolResult {
            call_id: "b".into(),
            name: "read".into(),
            output: json!({}),
            is_error: false,
            media: vec![Media::Audio(audio(bytes()))],
        }]));
        let body = capture(protocol, input).await;
        match protocol {
            Protocol::OpenAiChat => {
                assert_eq!(body["messages"][3]["tool_call_id"], "a");
                assert_eq!(body["messages"][4]["tool_call_id"], "b");
                assert_eq!(body["messages"][5]["role"], "user");
                assert!(
                    body["messages"][6]["content"][0]["text"]
                        .as_str()
                        .unwrap()
                        .contains("2")
                );
            }
            Protocol::Gemini => {
                let parts = &body["contents"][2]["parts"];
                assert_eq!(parts[0]["functionResponse"]["id"], "a");
                assert_eq!(parts[1]["functionResponse"]["id"], "b");
                assert_eq!(parts[3]["inlineData"]["mimeType"], "audio/wav");
                assert!(parts[4]["text"].as_str().unwrap().contains("2"));
            }
            Protocol::Bedrock => {
                let parts = &body["messages"][2]["content"];
                assert_eq!(parts[0]["toolResult"]["toolUseId"], "a");
                assert_eq!(parts[1]["toolResult"]["toolUseId"], "b");
                assert_eq!(parts[3]["audio"]["format"], "wav");
                assert!(parts[4]["text"].as_str().unwrap().contains("2"));
            }
            _ => unreachable!(),
        }
    }
}

#[tokio::test]
async fn bedrock_mixed_tool_results_preserve_media_order_for_the_whole_group() {
    for split in [false, true] {
        for audio_first in [true, false] {
            let audio = Media::Audio(audio(bytes()));
            let video = Media::Video(video(bytes()));
            let (first, second) = if audio_first {
                (audio, video)
            } else {
                (video, audio)
            };
            let mut input = with_media(vec![first], true);
            input.messages[2]
                .content
                .push(ContentPart::ToolCall(ToolCall {
                    id: "b".into(),
                    name: "read".into(),
                    arguments: json!({}),
                }));
            let result = ToolResult {
                call_id: "b".into(),
                name: "read".into(),
                output: json!({"summary":"second"}),
                is_error: false,
                media: vec![second],
            };
            if split {
                input.messages.push(Message::tool_results(vec![result]));
            } else {
                input.messages[3]
                    .content
                    .push(ContentPart::ToolResult(result));
            }
            let body = capture(Protocol::Bedrock, input).await;
            let parts = body["messages"][2]["content"].as_array().unwrap();
            assert_eq!(parts[0]["toolResult"]["toolUseId"], "a");
            assert_eq!(parts[1]["toolResult"]["toolUseId"], "b");
            let kinds = if audio_first {
                ["audio", "video"]
            } else {
                ["video", "audio"]
            };
            let delivered: Vec<_> = parts
                .iter()
                .flat_map(|part| {
                    std::iter::once(part).chain(
                        part["toolResult"]["content"]
                            .as_array()
                            .into_iter()
                            .flatten(),
                    )
                })
                .filter_map(|part| {
                    if part.get("audio").is_some() {
                        Some("audio")
                    } else if part.get("video").is_some() {
                        Some("video")
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(delivered, kinds, "{parts:?}");
        }
    }
}

#[tokio::test]
async fn audio_request_uses_the_same_mapping_with_streamed_responses() {
    let mut server = Server::start(vec![Fixture::sse(
        vec![chat_chunk(json!({"content":"heard"}), json!("stop"))],
        true,
    )])
    .await;
    let mut config = settings(Protocol::OpenAiChat, &server.url);
    config.capabilities.streaming = true;
    let model = HttpModel::new(config).unwrap();
    let response = generate(
        &model,
        with_media(vec![Media::Audio(audio(bytes()))], false),
        context(),
    )
    .await
    .unwrap();
    assert_eq!(response.message.text_content(), "heard");
    server.finish().await;
    assert_eq!(
        server.requests.lock().unwrap()[0].body["messages"][1]["content"][1]["input_audio"]["data"],
        "AQIDBA=="
    );
}

#[tokio::test]
async fn request_budget_counts_base64_sum_and_the_complete_json_before_auth() {
    let input = with_media(
        vec![Media::Audio(audio(bytes())), Media::Video(video(bytes()))],
        true,
    );
    let mut config = settings(Protocol::Gemini, "http://127.0.0.1:1");
    config.max_request_bytes = 15;
    rejected(config.clone(), input.clone(), "Base64").await;
    config.max_request_bytes = 16;
    rejected(config.clone(), input.clone(), "JSON").await;
    let body = capture(Protocol::Gemini, input.clone()).await;
    let size = serde_json::to_vec(&body).unwrap().len();
    config.max_request_bytes = size - 1;
    rejected(config, input.clone(), "JSON").await;

    let mut server =
        Server::start(vec![Fixture::json(images::response_body(Protocol::Gemini))]).await;
    let mut config = settings(Protocol::Gemini, &server.url);
    config.max_request_bytes = size;
    generate(&HttpModel::new(config).unwrap(), input, context())
        .await
        .unwrap();
    server.finish().await;
}

#[tokio::test]
async fn request_budget_includes_text_options_and_remote_references() {
    let mut input = with_media(
        vec![Media::Audio(audio(MediaSource::Url(
            "https://example.com/remote".into(),
        )))],
        false,
    );
    input
        .options
        .provider_options
        .insert("metadata".into(), json!({"large":"x".repeat(1024)}));
    let mut config = settings(Protocol::Gemini, "http://127.0.0.1:1");
    config.max_request_bytes = 1024;
    rejected(config.clone(), input, "JSON").await;
    let input = ModelRequest::new(vec![Message::text(Role::User, "x".repeat(1024))]);
    rejected(config, input, "JSON").await;
    let mut config = settings(Protocol::Gemini, "http://127.0.0.1:1");
    config.max_request_bytes = 0;
    assert!(HttpModel::new(config).is_err());
}
