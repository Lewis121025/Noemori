use super::*;
use crate::{ToolCall, llm::ReasoningEffort};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn request(config: &ModelConfig, request: &ModelRequest) -> Result<Value, Error> {
    let mut system = Vec::new();
    let mut messages = Vec::new();
    for message in &request.messages {
        if message.role == Role::System {
            system.push(json!({"type":"text","text":text_only(message)?}));
            continue;
        }
        let content = if let Some(raw) = native(config, message)? {
            raw
        } else {
            let mut parts = Vec::new();
            for part in &message.content {
                parts.push(match part {
                    ContentPart::Text(text)=>json!({"type":"text","text":text}),
                    ContentPart::ToolCall(call)=>json!({"type":"tool_use","id":call.id,"name":call.name,"input":call.arguments}),
                    ContentPart::ToolResult(result)=>tool_result(result)?,
                    ContentPart::Image(image)=>media::encode(config.protocol, MediaRef::Image(image))?,
                    ContentPart::Audio(audio)=>media::encode(config.protocol, MediaRef::Audio(audio))?,
                    ContentPart::Video(video)=>media::encode(config.protocol, MediaRef::Video(video))?,
                    ContentPart::Reasoning(_)=>return Err(Error::Unsupported("Anthropic 推理续轮需要原始签名".into())),
                });
            }
            json!(parts)
        };
        messages.push(json!({"role":if message.role==Role::Assistant {"assistant"}else{"user"},"content":content}));
    }
    let mut body = json!({"model":config.model,"messages":messages,"max_tokens":request.options.max_output_tokens.unwrap_or(4096),"stream":config.capabilities.streaming});
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if !request.tools.is_empty() {
        body["tools"]=json!(request.tools.iter().map(|tool|json!({"name":tool.name,"description":tool.description,"input_schema":tool.input_schema})).collect::<Vec<_>>());
    }
    common_options(&mut body, request, "max_tokens");
    if let Some(effort) = &config.reasoning_effort {
        match effort {
            ReasoningEffort::None => body["thinking"] = json!({"type": "disabled"}),
            _ => body["output_config"] = json!({"effort": effort}),
        }
    }
    if config.protocol == Protocol::VertexAnthropic {
        if let Some(object) = body.as_object_mut() {
            object.remove("model");
        }
        body["anthropic_version"] = json!("vertex-2023-10-16");
    }
    Ok(body)
}

fn tool_result(result: &crate::ToolResult) -> Result<Value, Error> {
    let content = if result.media.is_empty() {
        json!(result.output.to_string())
    } else {
        let mut parts = vec![json!({"type":"text","text":result.output.to_string()})];
        parts.extend(
            result
                .media
                .iter()
                .map(|item| media::encode(Protocol::Anthropic, item.as_ref()))
                .collect::<Result<Vec<_>, _>>()?,
        );
        json!(parts)
    };
    Ok(
        json!({"type":"tool_result","tool_use_id":result.call_id,"content":content,"is_error":result.is_error}),
    )
}

pub(super) fn response(config: &ModelConfig, body: Value) -> Result<ModelResponse, Error> {
    let raw = array(&body, "content")?;
    let mut content = Vec::new();
    for part in raw {
        match string(part, "type")? {
            "text" => content.push(ContentPart::Text(string(part, "text")?.into())),
            "thinking" => content.push(ContentPart::Reasoning(string(part, "thinking")?.into())),
            "redacted_thinking" => {}
            "tool_use" => content.push(ContentPart::ToolCall(ToolCall {
                id: string(part, "id")?.into(),
                name: string(part, "name")?.into(),
                arguments: part
                    .get("input")
                    .ok_or_else(|| Error::Protocol("工具缺少 input".into()))?
                    .clone(),
            })),
            other => return Err(Error::Unsupported(format!("Anthropic 内容类型：{other}"))),
        }
    }
    Ok(ModelResponse {
        finish_reason: finish(
            string(&body, "stop_reason")?,
            content
                .iter()
                .any(|p| matches!(p, ContentPart::ToolCall(_))),
        ),
        message: assistant(config, content, json!(raw)),
        usage: Usage {
            input_tokens: body["usage"]["input_tokens"].as_u64(),
            output_tokens: body["usage"]["output_tokens"].as_u64(),
            cached_input_tokens: body["usage"]["cache_read_input_tokens"].as_u64(),
            reasoning_tokens: None,
        },
        response_id: body["id"].as_str().map(str::to_owned),
    })
}

/// 跟踪内容块的开始与关闭，保留原始签名，并结合最终结束原因处理工具参数片段。
#[derive(Default)]
pub(super) struct StreamState {
    message: Value,
    blocks: BTreeMap<usize, Value>,
    arguments: BTreeMap<usize, String>,
    closed: BTreeSet<usize>,
    started: bool,
}

impl StreamState {
    pub fn feed(&mut self, config: &ModelConfig, body: Value) -> Result<Vec<ModelEvent>, Error> {
        match string(&body, "type")? {
            "message_start" => self.start_message(body["message"].clone())?,
            "content_block_start" => return self.start_block(&body),
            "content_block_delta" => return self.delta(&body),
            "content_block_stop" => self.stop_block(index(&body)?)?,
            "message_delta" => self.message_delta(&body)?,
            "message_stop" => return Ok(vec![ModelEvent::finished(self.finish(config)?)]),
            "ping" => {}
            "error" => return Err(Error::Protocol(format!("Anthropic 流失败：{body}"))),
            other => return Err(Error::Unsupported(format!("Anthropic 事件类型：{other}"))),
        }
        Ok(Vec::new())
    }

    fn start_message(&mut self, mut message: Value) -> Result<(), Error> {
        if self.started {
            return Err(Error::Protocol("重复 message_start".into()));
        }
        if !message.is_object() {
            return Err(Error::Protocol("message_start 缺少消息对象".into()));
        }
        if message["usage"].is_null() {
            message["usage"] = json!({});
        }
        if !message["usage"].is_object() {
            return Err(Error::Protocol("usage 必须是对象".into()));
        }
        self.message = message;
        self.started = true;
        Ok(())
    }

    fn start_block(&mut self, body: &Value) -> Result<Vec<ModelEvent>, Error> {
        self.require_started()?;
        let index = index(body)?;
        let block = &body["content_block"];
        if !block.is_object() {
            return Err(Error::Protocol("content_block 必须是对象".into()));
        }
        if !matches!(
            string(block, "type")?,
            "text" | "thinking" | "redacted_thinking" | "tool_use"
        ) {
            return Err(Error::Unsupported("Anthropic 内容块类型不支持".into()));
        }
        if self.blocks.insert(index, block.clone()).is_some() {
            return Err(Error::Protocol("重复内容块".into()));
        }
        let mut events = Vec::new();
        if let Some(text) = block["text"].as_str().filter(|s| !s.is_empty()) {
            events.push(ModelEvent::TextDelta(text.into()));
        }
        if let Some(text) = block["thinking"].as_str().filter(|s| !s.is_empty()) {
            events.push(ModelEvent::ReasoningDelta(text.into()));
        }
        Ok(events)
    }

    fn delta(&mut self, body: &Value) -> Result<Vec<ModelEvent>, Error> {
        let index = index(body)?;
        if self.closed.contains(&index) {
            return Err(Error::Protocol("内容块结束后仍有增量".into()));
        }
        let block = self
            .blocks
            .get_mut(&index)
            .ok_or_else(|| Error::Protocol("增量缺少起始内容块".into()))?;
        let delta = &body["delta"];
        let (expected, field) = match string(delta, "type")? {
            "text_delta" => ("text", "text"),
            "thinking_delta" => ("thinking", "thinking"),
            "signature_delta" => ("thinking", "signature"),
            "input_json_delta" => ("tool_use", "partial_json"),
            other => return Err(Error::Unsupported(format!("Anthropic 增量类型：{other}"))),
        };
        if block["type"] != expected {
            return Err(Error::Protocol("内容块类型与增量不匹配".into()));
        }
        let text = string(delta, field)?;
        if field == "partial_json" {
            self.arguments.entry(index).or_default().push_str(text);
            return Ok(vec![ModelEvent::ToolCallDelta {
                index,
                arguments: text.into(),
            }]);
        }
        let old = string(block, field)?.to_owned();
        block[field] = json!(old + text);
        Ok(match field {
            "text" => vec![ModelEvent::TextDelta(text.into())],
            "thinking" => vec![ModelEvent::ReasoningDelta(text.into())],
            _ => Vec::new(),
        })
    }

    fn stop_block(&mut self, index: usize) -> Result<(), Error> {
        if !self.closed.insert(index) {
            return Err(Error::Protocol("重复内容块结束".into()));
        }
        if !self.blocks.contains_key(&index) {
            return Err(Error::Protocol("结束事件缺少内容块".into()));
        }
        Ok(())
    }

    fn message_delta(&mut self, body: &Value) -> Result<(), Error> {
        self.require_started()?;
        if let Some(reason) = body["delta"].get("stop_reason") {
            self.message["stop_reason"] = reason.clone();
        }
        if let Some(usage) = body.get("usage").filter(|value| !value.is_null()) {
            let usage = usage
                .as_object()
                .ok_or_else(|| Error::Protocol("usage 必须是对象".into()))?;
            for (key, value) in usage {
                self.message["usage"][key] = value.clone();
            }
        }
        Ok(())
    }

    fn finish(&mut self, config: &ModelConfig) -> Result<ModelResponse, Error> {
        self.require_started()?;
        if self.closed.len() != self.blocks.len() {
            return Err(Error::Protocol("Anthropic 存在未结束内容块".into()));
        }
        let interrupted = matches!(
            finish(string(&self.message, "stop_reason")?, false),
            FinishReason::Length | FinishReason::ContentFilter
        );
        for (index, raw) in std::mem::take(&mut self.arguments) {
            match complete_arguments(&json!(raw), interrupted)? {
                Some(args) => {
                    self.blocks
                        .get_mut(&index)
                        .ok_or_else(|| Error::Protocol("工具参数缺少内容块".into()))?["input"] =
                        args
                }
                // 仅完整内容块构成最终消息；被截断的参数仍保留在流增量中。
                None => {
                    self.blocks.remove(&index);
                }
            }
        }
        self.message["content"] = json!(self.blocks.values().collect::<Vec<_>>());
        response(config, self.message.clone())
    }

    fn require_started(&self) -> Result<(), Error> {
        if self.started {
            Ok(())
        } else {
            Err(Error::Protocol("缺少 message_start".into()))
        }
    }
}

fn index(body: &Value) -> Result<usize, Error> {
    body["index"]
        .as_u64()
        .and_then(|v| usize::try_from(v).ok())
        .ok_or_else(|| Error::Protocol("内容块缺少索引".into()))
}
