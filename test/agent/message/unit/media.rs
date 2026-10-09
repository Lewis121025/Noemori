use noemori_agent::{
    Audio, AudioFormat, ContentPart, Media, MediaSource, Message, Role, ToolCall, ToolResult,
    Video, VideoFormat,
    llm::{Capabilities, ModelRequest},
    validate_history,
};
use serde_json::json;

fn audio(source: MediaSource) -> Audio {
    Audio::new(AudioFormat::Wav, source).unwrap()
}
fn video(source: MediaSource) -> Video {
    Video::new(VideoFormat::Mp4, source).unwrap()
}
fn image() -> noemori_agent::Image {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use noemori_agent::{Image, ImageFormat};
    Image::new(ImageFormat::Png, STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=").unwrap()).unwrap()
}

#[test]
fn image_history_uses_base64_and_restores_legacy_byte_arrays() {
    let image = image();
    let saved = serde_json::to_value(&image).unwrap();
    assert_eq!(saved["data"], image.base64());
    assert_eq!(serde_json::from_value::<noemori_agent::Image>(saved).unwrap(), image);
    let legacy = json!({"format":"png","data":image.data()});
    assert_eq!(serde_json::from_value::<noemori_agent::Image>(legacy).unwrap(), image);
}
fn input(part: ContentPart) -> ModelRequest {
    ModelRequest::new(vec![Message {
        role: Role::User,
        content: vec![part],
        provider_data: None,
    }])
}
fn tool_input(media: Vec<Media>) -> ModelRequest {
    ModelRequest::new(vec![
        Message {
            role: Role::Assistant,
            content: vec![ContentPart::ToolCall(ToolCall {
                id: "a".into(),
                name: "read".into(),
                arguments: json!({}),
            })],
            provider_data: None,
        },
        Message::tool_results(vec![ToolResult {
            call_id: "a".into(),
            name: "read".into(),
            output: json!({}),
            is_error: false,
            media,
        }]),
    ])
}

#[test]
fn byte_sources_enforce_empty_and_upper_bound_and_share_storage() {
    assert!(MediaSource::bytes(vec![]).is_err());
    assert!(MediaSource::bytes(vec![0; 25 * 1024 * 1024 + 1]).is_err());
    let source = MediaSource::bytes(vec![0; 25 * 1024 * 1024]).unwrap();
    let (MediaSource::Bytes(a), MediaSource::Bytes(b)) = (&source, source.clone()) else {
        panic!()
    };
    assert!(std::sync::Arc::ptr_eq(a, &b));
}

#[test]
fn source_ownership_and_uri_contracts_are_checked_without_exposing_signed_urls() {
    let valid = [
        MediaSource::Url("https://example.com/movie.mp4?signature=secret".into()),
        MediaSource::GeminiFile(
            "https://generativelanguage.googleapis.com/v1beta/files/abc-123".into(),
        ),
        MediaSource::Gcs("gs://bucket/path/movie.mp4".into()),
        MediaSource::S3 {
            uri: "s3://bucket/path/movie.mp4".into(),
            bucket_owner: Some("123456789012".into()),
        },
    ];
    for source in valid {
        let media = video(source.clone());
        assert_eq!(
            serde_json::from_value::<Video>(serde_json::to_value(&media).unwrap()).unwrap(),
            media
        );
        assert!(!format!("{media:?}").contains("movie"));
        assert!(!format!("{media:?}").contains("secret"));
    }
    for source in [
        MediaSource::Url("file:///private/movie".into()),
        MediaSource::Url("https://user:secret@example.com/movie".into()),
        MediaSource::Url("https://example.com/movie#fragment".into()),
        MediaSource::Url("https://example.com/white space".into()),
        MediaSource::Url("https://example.com/\nsecret".into()),
        MediaSource::Url(format!("https://example.com/{}", "a".repeat(8192))),
        MediaSource::GeminiFile("https://example.com/v1beta/files/id".into()),
        MediaSource::GeminiFile(
            "https://generativelanguage.googleapis.com/v1beta/files/id?secret=x".into(),
        ),
        MediaSource::Gcs("s3://bucket/movie".into()),
        MediaSource::Gcs("gs://bucket/".into()),
        MediaSource::S3 {
            uri: "s3://bucket/movie?secret=x".into(),
            bucket_owner: None,
        },
        MediaSource::S3 {
            uri: "s3://bucket/movie".into(),
            bucket_owner: Some("secret".into()),
        },
    ] {
        let error = Audio::new(AudioFormat::Mp3, source).unwrap_err();
        assert!(!error.to_string().contains("secret"));
    }
}

#[test]
fn user_and_tool_media_require_independent_capabilities() {
    let source = MediaSource::bytes(vec![1, 2, 3]).unwrap();
    for request in [
        input(ContentPart::Audio(audio(source.clone()))),
        tool_input(vec![Media::Audio(audio(source.clone()))]),
    ] {
        assert!(
            request
                .validate(Capabilities {
                    vision: true,
                    video: true,
                    ..Capabilities::default()
                })
                .is_err()
        );
        request
            .validate(Capabilities {
                audio: true,
                ..Capabilities::default()
            })
            .unwrap();
    }
    for request in [
        input(ContentPart::Video(video(source.clone()))),
        tool_input(vec![Media::Video(video(source.clone()))]),
    ] {
        assert!(
            request
                .validate(Capabilities {
                    vision: true,
                    audio: true,
                    ..Capabilities::default()
                })
                .is_err()
        );
        request
            .validate(Capabilities {
                video: true,
                ..Capabilities::default()
            })
            .unwrap();
    }
}

#[test]
fn media_cannot_be_assistant_or_system_content_and_deserialization_cannot_bypass_validation() {
    let part = ContentPart::Audio(audio(MediaSource::bytes(vec![1]).unwrap()));
    for role in [Role::Assistant, Role::System, Role::Tool] {
        assert!(
            validate_history(&[Message {
                role,
                content: vec![part.clone()],
                provider_data: None
            }])
            .is_err()
        );
    }
    let audio: Audio =
        serde_json::from_value(json!({"format":"wav","source":{"type":"bytes","value":[]}}))
            .unwrap();
    assert!(validate_history(&input(ContentPart::Audio(audio.clone())).messages).is_err());
    assert!(validate_history(&tool_input(vec![Media::Audio(audio)]).messages).is_err());
    let video: Video = serde_json::from_value(
        json!({"format":"mp4","source":{"type":"url","value":"file:///secret"}}),
    )
    .unwrap();
    assert!(validate_history(&input(ContentPart::Video(video)).messages).is_err());
}

#[test]
fn ordered_media_round_trip_and_legacy_images_migrate_without_silent_loss() {
    let image = image();
    let mut old =
        json!({"call_id":"a","name":"read","output":{},"is_error":false,"images":[image]});
    let mut result: ToolResult = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(result.media, vec![Media::Image(image)]);
    result
        .media
        .push(Media::Audio(audio(MediaSource::bytes(vec![1]).unwrap())));
    result.media.push(Media::Video(video(MediaSource::Url(
        "https://example.com/video".into(),
    ))));
    let saved = serde_json::to_value(&result).unwrap();
    assert!(saved.get("images").is_none());
    assert_eq!(saved["media"][1]["type"], "audio");
    assert_eq!(serde_json::from_value::<ToolResult>(saved).unwrap(), result);
    old["media"] = json!([]);
    assert!(serde_json::from_value::<ToolResult>(old).is_err());
}

#[test]
fn malformed_tagged_media_never_fall_back_to_legacy_images() {
    let mut stored_image = serde_json::to_value(image()).unwrap();
    stored_image["type"] = json!("audio");
    stored_image["value"] = json!({"format":"wav","source":{"type":"bytes","value":[1]}});
    for tag in ["audio", "video", "unknown"] {
        stored_image["type"] = json!(tag);
        for field in ["media", "images"] {
            let mut result = json!({"call_id":"a","name":"read","output":{},"is_error":false});
            result[field] = json!([stored_image]);
            assert!(
                serde_json::from_value::<ToolResult>(result).is_err(),
                "invalid {tag} must not become a legacy image in {field}"
            );
        }
    }
}
