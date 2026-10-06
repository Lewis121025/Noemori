//! 媒体只映射到协议声明的原生字段；来源或格式不兼容时在认证和网络请求前失败。

use super::*;
use crate::{AudioFormat, MediaSource, VideoFormat, media::MediaRef};
use base64::{Engine, engine::general_purpose::STANDARD};

pub(super) fn encode(protocol: Protocol, media: MediaRef<'_>) -> Result<Value, Error> {
    if let MediaRef::Image(image) = media {
        return Ok(match protocol {
            Protocol::OpenAiChat => {
                json!({"type":"image_url","image_url":{"url":image.data_url()}})
            }
            Protocol::OpenAiResponses => json!({"type":"input_image","image_url":image.data_url()}),
            Protocol::Anthropic | Protocol::VertexAnthropic => {
                json!({"type":"image","source":{"type":"base64","media_type":image.format().mime_type(),"data":image.base64()}})
            }
            Protocol::Gemini => {
                json!({"inlineData":{"mimeType":image.format().mime_type(),"data":image.base64()}})
            }
            Protocol::Bedrock => {
                json!({"image":{"format":image.format(),"source":{"bytes":image.base64()}}})
            }
            Protocol::Ollama => json!(image.base64()),
        });
    }
    match protocol {
        Protocol::OpenAiChat => chat(media),
        Protocol::Gemini => gemini(media),
        Protocol::Bedrock => bedrock(media),
        _ => Err(Error::Unsupported(format!(
            "{} 协议不支持原生音频或视频输入",
            protocol.key()
        ))),
    }
}

fn chat(media: MediaRef<'_>) -> Result<Value, Error> {
    let MediaRef::Audio(audio) = media else {
        return Err(Error::Unsupported(
            "Chat Completions 不支持原生视频输入".into(),
        ));
    };
    let format = match audio.format() {
        AudioFormat::Wav => "wav",
        AudioFormat::Mp3 => "mp3",
        _ => {
            return Err(Error::Unsupported(
                "Chat Completions 音频输入仅支持 WAV、MP3".into(),
            ));
        }
    };
    let MediaSource::Bytes(bytes) = audio.source() else {
        return Err(Error::Unsupported(
            "Chat Completions 音频输入仅支持本地字节，不支持 URL 或文件引用".into(),
        ));
    };
    Ok(json!({"type":"input_audio","input_audio":{"format":format,"data":STANDARD.encode(bytes)}}))
}

fn gemini(media: MediaRef<'_>) -> Result<Value, Error> {
    let (mime, source) = match media {
        MediaRef::Audio(audio) => (audio.format().mime_type(), audio.source()),
        MediaRef::Video(video) => {
            let mime = match video.format() {
                VideoFormat::Mov => "video/mov",
                VideoFormat::Avi => "video/avi",
                VideoFormat::Wmv => "video/wmv",
                VideoFormat::Mkv => {
                    return Err(Error::Unsupported("Gemini 不支持 MKV 视频输入".into()));
                }
                format => format.mime_type(),
            };
            (mime, video.source())
        }
        MediaRef::Image(_) => return Err(Error::Protocol("图片必须由公共媒体映射处理".into())),
    };
    match source {
        MediaSource::Bytes(bytes) => {
            Ok(json!({"inlineData":{"mimeType":mime,"data":STANDARD.encode(bytes)}}))
        }
        MediaSource::Url(uri) | MediaSource::GeminiFile(uri) | MediaSource::Gcs(uri) => {
            Ok(json!({"fileData":{"mimeType":mime,"fileUri":uri}}))
        }
        MediaSource::S3 { .. } => Err(Error::Unsupported(
            "Gemini 不支持 S3 媒体引用，请提供可访问的 URL、Gemini 文件或 GCS 引用".into(),
        )),
    }
}

fn bedrock(media: MediaRef<'_>) -> Result<Value, Error> {
    let (kind, format, source) = match media {
        MediaRef::Audio(audio) => {
            let format = match audio.format() {
                AudioFormat::Wav => "wav",
                AudioFormat::Mp3 => "mp3",
                AudioFormat::Aac => "aac",
                AudioFormat::Flac => "flac",
                AudioFormat::Ogg => "ogg",
                AudioFormat::Opus => "opus",
                AudioFormat::M4a => "m4a",
                AudioFormat::Webm => "webm",
                AudioFormat::Aiff => {
                    return Err(Error::Unsupported(
                        "Bedrock Converse 不支持 AIFF 音频输入".into(),
                    ));
                }
            };
            ("audio", format, audio.source())
        }
        MediaRef::Video(video) => {
            let format = match video.format() {
                VideoFormat::Mp4 => "mp4",
                VideoFormat::Webm => "webm",
                VideoFormat::Mov => "mov",
                VideoFormat::Mkv => "mkv",
                VideoFormat::Mpeg => "mpeg",
                VideoFormat::Flv => "flv",
                VideoFormat::Wmv => "wmv",
                VideoFormat::ThreeGp => "three_gp",
                VideoFormat::Avi => {
                    return Err(Error::Unsupported(
                        "Bedrock Converse 不支持 AVI 视频输入".into(),
                    ));
                }
            };
            ("video", format, video.source())
        }
        MediaRef::Image(_) => return Err(Error::Protocol("图片必须由公共媒体映射处理".into())),
    };
    let source = match source {
        MediaSource::Bytes(bytes) => json!({"bytes":STANDARD.encode(bytes)}),
        MediaSource::S3 { uri, bucket_owner } => {
            let mut location = json!({"uri":uri});
            if let Some(owner) = bucket_owner {
                location["bucketOwner"] = json!(owner);
            }
            json!({"s3Location":location})
        }
        _ => {
            return Err(Error::Unsupported(
                "Bedrock Converse 音视频只支持本地字节或 S3 引用".into(),
            ));
        }
    };
    Ok(json!({kind:{"format":format,"source":source}}))
}
