use super::*;
use crate::{ToolCall, llm::ReasoningEffort};

pub(super) fn request(config: &ModelConfig, request: &ModelRequest) -> Result<Value, Error> {
    validate_images(request)?;
    let mut system = Vec::new();
    let mut messages = Vec::new();
    for group in request
        .messages
        .chunk_by(|a, b| a.role == Role::Tool && b.role == Role::Tool)
    {
        let message = &group[0];
        if message.role == Role::System {
            system.push(json!({"text":text_only(message)?}));
            continue;
        }
        let content = if let Some(raw) = native(config, message)? {
            raw
        } else {
            json!(message_parts(group)?)
        };
        messages.push(json!({"role":if message.role==Role::Assistant{"assistant"}else{"user"},"content":content}));
    }
    let mut body = json!({"messages":messages});
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if !request.tools.is_empty() {
        body["toolConfig"] = json!({"tools":request.tools.iter().map(|tool|json!({"toolSpec":{"name":tool.name,"description":tool.description,"inputSchema":{"json":tool.input_schema}}})).collect::<Vec<_>>()});
    }
    let options = sampling_options(request, "topP", "maxTokens");
    if !options.is_empty() {
        body["inferenceConfig"] = json!(options);
    }
    if let Some(effort) = &config.reasoning_effort {
        body["additionalModelRequestFields"] = reasoning_fields(&config.model, effort);
    }
    Ok(body)
}

/// 仅按 AWS 模型命名空间选择原生字段，不从型号或版本猜测可用档位。
fn reasoning_fields(model: &str, effort: &ReasoningEffort) -> Value {
    // 基础模型与跨区域 profile 的 ARN 都把模型身份放在最后一段资源路径。
    let resource = model.rsplit('/').next().unwrap_or(model);
    let model_id = ["us.", "eu.", "jp.", "apac.", "global."]
        .iter()
        .find_map(|prefix| resource.strip_prefix(prefix))
        .unwrap_or(resource);
    if model_id.starts_with("anthropic.") {
        match effort {
            ReasoningEffort::None => json!({"thinking": {"type": "disabled"}}),
            _ => json!({"output_config": {"effort": effort}}),
        }
    } else if model_id.starts_with("amazon.nova-") {
        match effort {
            ReasoningEffort::None => json!({"reasoningConfig": {"type": "disabled"}}),
            _ => json!({"reasoningConfig": {"type": "enabled", "maxReasoningEffort": effort}}),
        }
    } else {
        // 自定义网关也按官方 OpenAI 字段透传；不预判其模型或档位支持情况。
        json!({"reasoning_effort": effort})
    }
}

fn message_parts(group: &[Message]) -> Result<Vec<Value>, Error> {
    // ToolResultContentBlock 没有 audio；整组媒体采用同一布局，避免延后的音频被后续嵌套视频抢先。
    let separate_media = group
        .iter()
        .flat_map(|message| &message.content)
        .flat_map(ContentPart::media)
        .any(|media| matches!(media, MediaRef::Audio(_)));
    let mut parts = Vec::new();
    let mut attachments = Vec::new();
    let mut result_index = 0;
    for part in group.iter().flat_map(|message| &message.content) {
        parts.push(match part {
            ContentPart::Text(text) => json!({"text": text}),
            ContentPart::ToolCall(call) => json!({
                "toolUse": {"toolUseId": call.id, "name": call.name, "input": call.arguments}
            }),
            ContentPart::ToolResult(result) => {
                result_index += 1;
                let (value, extra) = tool_result(result, result_index, separate_media)?;
                attachments.extend(extra);
                value
            }
            ContentPart::Image(image) => media::encode(Protocol::Bedrock, MediaRef::Image(image))?,
            ContentPart::Audio(audio) => media::encode(Protocol::Bedrock, MediaRef::Audio(audio))?,
            ContentPart::Video(video) => media::encode(Protocol::Bedrock, MediaRef::Video(video))?,
            ContentPart::Reasoning(_) => {
                return Err(Error::Unsupported("Bedrock 推理续轮需要原生签名".into()));
            }
        });
    }
    parts.extend(attachments);
    Ok(parts)
}

// Bedrock 的限制作用于每条消息，工具结果中的图片也属于该消息的图像输入。
fn validate_images(request: &ModelRequest) -> Result<(), Error> {
    for group in request
        .messages
        .chunk_by(|a, b| a.role == Role::Tool && b.role == Role::Tool)
    {
        let images: Vec<_> = group
            .iter()
            .flat_map(|message| &message.content)
            .flat_map(ContentPart::media)
            .filter_map(|media| match media {
                MediaRef::Image(image) => Some(image),
                _ => None,
            })
            .collect();
        if images.len() > 20 {
            return Err(Error::Config("Bedrock 每条消息最多允许 20 张图片".into()));
        }
        if images.iter().any(|image| image.data().len() > 3_750_000) {
            return Err(Error::Config(
                "Bedrock 单张图片不得超过 3.75 MB（3,750,000 字节）".into(),
            ));
        }
    }
    Ok(())
}

fn tool_result(
    result: &crate::ToolResult,
    index: usize,
    separate_media: bool,
) -> Result<(Value, Vec<Value>), Error> {
    let mut content = vec![json!({"json":result.output})];
    let media = result
        .media
        .iter()
        .map(|item| media::encode(Protocol::Bedrock, item.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut extra = Vec::new();
    if separate_media && !media.is_empty() {
        extra
            .push(json!({"text":format!("本轮第 {index} 个工具结果（{}）的媒体附件",result.name)}));
        extra.extend(media);
    } else {
        content.extend(media);
    }
    Ok((
        json!({"toolResult":{"toolUseId":result.call_id,"content":content,"status":if result.is_error {"error"} else {"success"}}}),
        extra,
    ))
}

/// 跟踪内容块闭合；文本可从增量开始，工具必须先声明，消息结束时统一核验。
#[derive(Default)]
pub(super) struct StreamState {
    blocks: std::collections::BTreeMap<usize, Value>,
    arguments: std::collections::BTreeMap<usize, String>,
    closed: std::collections::BTreeSet<usize>,
    started: bool,
    reason: Option<String>,
    usage: Value,
}

impl StreamState {
    pub fn feed(&mut self, event: Value) -> Result<Vec<ModelEvent>, Error> {
        let body = &event["payload"];
        let kind = string(&event, "type")?;
        if kind != "messageStart" && !self.started {
            return Err(Error::Protocol("Bedrock 缺少 messageStart".into()));
        }
        if self.reason.is_some() && kind != "metadata" {
            return Err(Error::Protocol("Bedrock 消息结束后仍有内容事件".into()));
        }
        match kind {
            "messageStart" => {
                if self.started || body["role"] != "assistant" {
                    return Err(Error::Protocol("Bedrock messageStart 无效".into()));
                }
                self.started = true;
            }
            "contentBlockStart" => {
                let index = block_index(body)?;
                let call = &body["start"]["toolUse"];
                if self.blocks.insert(index, json!({"toolUse":{"toolUseId":string(call,"toolUseId")?,"name":string(call,"name")?,"input":{}}})).is_some() {
                    return Err(Error::Protocol("Bedrock 内容块重复".into()));
                }
            }
            "contentBlockDelta" => return self.delta(body),
            "contentBlockStop" => {
                let index = block_index(body)?;
                if !self.closed.insert(index) {
                    return Err(Error::Protocol("Bedrock 内容块重复结束".into()));
                }
                if !self.blocks.contains_key(&index) {
                    return Err(Error::Protocol("Bedrock 缺少内容块".into()));
                }
            }
            "messageStop" => {
                if self.blocks.len() != self.closed.len() {
                    return Err(Error::Protocol("Bedrock 存在未闭合内容块".into()));
                }
                let reason = string(body, "stopReason")?;
                let interrupted = matches!(
                    finish(reason, false),
                    FinishReason::Length | FinishReason::ContentFilter
                );
                for (index, raw) in std::mem::take(&mut self.arguments) {
                    match complete_arguments(&json!(raw), interrupted)? {
                        Some(args) => {
                            self.blocks
                                .get_mut(&index)
                                .ok_or_else(|| Error::Protocol("工具参数缺少内容块".into()))?["toolUse"]
                                ["input"] = args
                        }
                        None => {
                            self.blocks.remove(&index);
                        }
                    }
                }
                self.reason = Some(reason.into());
            }
            "metadata" => self.usage = body["usage"].clone(),
            other => return Err(Error::Unsupported(format!("Bedrock 事件类型：{other}"))),
        }
        Ok(Vec::new())
    }

    fn delta(&mut self, body: &Value) -> Result<Vec<ModelEvent>, Error> {
        let index = block_index(body)?;
        if self.closed.contains(&index) {
            return Err(Error::Protocol("Bedrock 已关闭内容块仍有增量".into()));
        }
        let delta = &body["delta"];
        if let Some(text) = delta["text"].as_str() {
            let block = self
                .blocks
                .entry(index)
                .or_insert_with(|| json!({"text":""}));
            let old = string(block, "text")?.to_owned();
            block["text"] = json!(old + text);
            return Ok(vec![ModelEvent::TextDelta(text.into())]);
        }
        if let Some(text) = delta["toolUse"]["input"].as_str() {
            if !self
                .blocks
                .get(&index)
                .is_some_and(|block| block.get("toolUse").is_some())
            {
                return Err(Error::Protocol("Bedrock 工具增量缺少起始事件".into()));
            }
            self.arguments.entry(index).or_default().push_str(text);
            return Ok(vec![ModelEvent::ToolCallDelta {
                index,
                arguments: text.into(),
            }]);
        }
        if let Some(reasoning) = delta.get("reasoningContent") {
            let block = self.blocks.entry(index).or_insert_with(
                || json!({"reasoningContent":{"reasoningText":{"text":"","signature":""}}}),
            );
            let target = &mut block["reasoningContent"]["reasoningText"];
            for field in ["text", "signature"] {
                if let Some(text) = reasoning[field].as_str() {
                    let old = target[field].as_str().unwrap_or_default().to_owned();
                    target[field] = json!(old + text);
                }
            }
            return Ok(reasoning["text"]
                .as_str()
                .map(|text| ModelEvent::ReasoningDelta(text.into()))
                .into_iter()
                .collect());
        }
        Err(Error::Unsupported("Bedrock 增量类型不支持".into()))
    }

    pub fn finish(&self, config: &ModelConfig) -> Result<ModelResponse, Error> {
        let reason = self
            .reason
            .as_ref()
            .ok_or_else(|| Error::Protocol("Bedrock 缺少 messageStop".into()))?;
        response(
            config,
            json!({"output":{"message":{"role":"assistant","content":self.blocks.values().collect::<Vec<_>>()}},"stopReason":reason,"usage":self.usage}),
        )
    }
}

fn block_index(body: &Value) -> Result<usize, Error> {
    body["contentBlockIndex"]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
        .ok_or_else(|| Error::Protocol("Bedrock 缺少内容块索引".into()))
}

pub(super) fn response(config: &ModelConfig, body: Value) -> Result<ModelResponse, Error> {
    let raw = array(&body["output"]["message"], "content")?;
    let mut content = Vec::new();
    for part in raw {
        if let Some(text) = part["text"].as_str() {
            content.push(ContentPart::Text(text.into()));
        } else if let Some(call) = part.get("toolUse") {
            content.push(ContentPart::ToolCall(ToolCall {
                id: string(call, "toolUseId")?.into(),
                name: string(call, "name")?.into(),
                arguments: call
                    .get("input")
                    .cloned()
                    .ok_or_else(|| Error::Protocol("Bedrock 工具缺少 input".into()))?,
            }));
        } else if let Some(reasoning) = part.get("reasoningContent") {
            if let Some(text) = reasoning["reasoningText"]["text"].as_str() {
                content.push(ContentPart::Reasoning(text.into()));
            }
        } else {
            return Err(Error::Unsupported("Bedrock 返回了未支持的内容块".into()));
        }
    }
    Ok(ModelResponse {
        finish_reason: finish(
            string(&body, "stopReason")?,
            content
                .iter()
                .any(|p| matches!(p, ContentPart::ToolCall(_))),
        ),
        message: assistant(config, content, json!(raw)),
        usage: Usage {
            input_tokens: body["usage"]["inputTokens"].as_u64(),
            output_tokens: body["usage"]["outputTokens"].as_u64(),
            cached_input_tokens: body["usage"]["cacheReadInputTokens"].as_u64(),
            reasoning_tokens: None,
        },
        response_id: None,
    })
}
