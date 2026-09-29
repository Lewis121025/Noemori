//! 有界 HTTP 读取和流分帧；协议解码器只接收完整事件。

use super::Protocol;
use crate::{Error, ExecutionContext};
use aws_smithy_eventstream::frame::{DecodedFrame, MessageFrameDecoder};
use bytes::{Bytes, BytesMut};
use eventsource_stream::{EventStreamError, Eventsource};
use futures::{Stream, StreamExt, TryStreamExt};
use serde_json::{Value, json};
use std::pin::Pin;

pub(super) type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, Error>> + Send>>;
pub(super) type WireStream = Pin<Box<dyn Stream<Item = Result<String, Error>> + Send>>;

pub(super) fn limited_bytes(
    response: reqwest::Response,
    context: ExecutionContext,
    limit: usize,
) -> ByteStream {
    Box::pin(async_stream::try_stream! {
        let mut stream = response.bytes_stream();
        let mut total = 0usize;
        while let Some(chunk) = context.wait(stream.next()).await? {
            let chunk = chunk.map_err(transport_error)?;
            total = total.checked_add(chunk.len()).filter(|size| *size <= limit)
                .ok_or_else(|| Error::Protocol("模型响应超过字节上限".into()))?;
            yield chunk;
        }
    })
}

pub(super) fn transport_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::Timeout
    } else {
        Error::Transport(error.without_url())
    }
}

pub(super) async fn read_body(
    response: reqwest::Response,
    context: ExecutionContext,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    let mut stream = limited_bytes(response, context, limit);
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk?);
    }
    Ok(body)
}

pub(super) fn events(bytes: ByteStream, protocol: Protocol) -> WireStream {
    match protocol {
        Protocol::Ollama => ndjson(bytes),
        Protocol::Bedrock => bedrock(bytes),
        _ => Box::pin(bytes.eventsource().map_ok(|event| event.data).map_err(
            |error| match error {
                EventStreamError::Transport(error) => error,
                other => Error::Protocol(format!("SSE 解码失败：{other}")),
            },
        )),
    }
}

fn ndjson(mut bytes: ByteStream) -> WireStream {
    Box::pin(async_stream::try_stream! {
        let mut buffer = Vec::new();
        while let Some(chunk) = bytes.next().await {
            buffer.extend_from_slice(&chunk?);
            while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<_> = buffer.drain(..=end).collect();
                yield String::from_utf8(line).map_err(|_| Error::Protocol("NDJSON 不是 UTF-8".into()))?;
            }
        }
        if !buffer.is_empty() {
            yield String::from_utf8(buffer).map_err(|_| Error::Protocol("NDJSON 尾部不是 UTF-8".into()))?;
        }
    })
}

fn bedrock(mut bytes: ByteStream) -> WireStream {
    Box::pin(async_stream::try_stream! {
        let mut buffer = BytesMut::new();
        let mut decoder = MessageFrameDecoder::new();
        let mut incomplete = false;
        while let Some(chunk) = bytes.next().await {
            buffer.extend_from_slice(&chunk?);
            while !buffer.is_empty() {
                match decoder.decode_frame(&mut buffer).map_err(|error| Error::Protocol(format!("AWS 事件帧损坏：{error}")))? {
                    DecodedFrame::Incomplete => { incomplete = true; break; }
                    DecodedFrame::Complete(message) => {
                        incomplete = false;
                        let headers = message.headers();
                        let kind = headers.iter().find(|header| header.name().as_str() == ":message-type")
                            .and_then(|header| header.value().as_string().ok()).map(|value| value.as_str());
                        if kind != Some("event") {
                            Err(Error::Protocol(format!("Bedrock 流返回异常：{}", String::from_utf8_lossy(message.payload()))))?;
                        }
                        let event = headers.iter().find(|header| header.name().as_str() == ":event-type")
                            .and_then(|header| header.value().as_string().ok()).map(|value| value.as_str())
                            .ok_or_else(|| Error::Protocol("Bedrock 帧缺少事件类型".into()))?;
                        let payload: Value = serde_json::from_slice(message.payload())
                            .map_err(|error| Error::Protocol(format!("Bedrock 事件不是 JSON：{error}")))?;
                        yield json!({"type": event, "payload": payload}).to_string();
                    }
                }
            }
        }
        if incomplete || !buffer.is_empty() { Err(Error::Protocol("Bedrock 存在未完成事件帧".into()))?; }
    })
}
