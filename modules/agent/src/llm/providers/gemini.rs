use super::*;
use crate::{ToolCall, llm::ReasoningEffort};

pub(super) fn request(config: &ModelConfig, request: &ModelRequest) -> Result<Value, Error> {
    let mut contents = Vec::new();
    let mut system = Vec::new();
    for group in request
        .messages
        .chunk_by(|a, b| a.role == Role::Tool && b.role == Role::Tool)
    {
        let message = &group[0];
        if message.role == Role::System {
            system.push(json!({"text":text_only(message)?}));
            continue;
        }
        let parts = if let Some(raw) = native(config, message)? {
            raw
        } else {
            json!(message_parts(request, group)?)
        };
        contents.push(
            json!({"role":if message.role==Role::Assistant{"model"}else{"user"},"parts":parts}),
        );
    }
    let mut body = json!({"contents":contents});
    if !system.is_empty() {
        body["systemInstruction"] = json!({"parts":system});
    }
    if !request.tools.is_empty() {
        body["tools"] = json!([{"functionDeclarations":request.tools.iter().map(|tool|json!({"name":tool.name,"description":tool.description,"parametersJsonSchema":tool.input_schema})).collect::<Vec<_>>()}]);
    }
    let options = sampling_options(request, "topP", "maxOutputTokens");
    if !options.is_empty() {
        body["generationConfig"] = json!(options);
    }
    if let Some(effort) = &config.reasoning_effort {
        body["generationConfig"]["thinkingConfig"] = thinking_config(&config.model, effort);
    }
    Ok(body)
}

/// 2.5 使用官方兼容档位预算表；其他版本用 REST 枚举，不据此裁剪模型可选档位。
fn thinking_config(model: &str, effort: &ReasoningEffort) -> Value {
    let uses_budget = model
        .strip_prefix("models/")
        .unwrap_or(model)
        .starts_with("gemini-2.5-");
    let budget = match effort {
        ReasoningEffort::None => Some(0),
        ReasoningEffort::Minimal | ReasoningEffort::Low if uses_budget => Some(1024),
        ReasoningEffort::Medium if uses_budget => Some(8192),
        ReasoningEffort::High if uses_budget => Some(24576),
        _ => None,
    };
    if let Some(budget) = budget {
        return json!({"thinkingBudget": budget});
    }
    let level = match effort {
        ReasoningEffort::Named(value) => value.clone(),
        _ => effort.as_str().to_ascii_uppercase(),
    };
    json!({"thinkingLevel": level})
}

// 工具结果与附件分别排列，防止并行调用尚未闭合时夹入用户媒体；说明文字保留附件归属。
fn message_parts(request: &ModelRequest, group: &[Message]) -> Result<Vec<Value>, Error> {
    let mut parts = Vec::new();
    let mut attachments = Vec::new();
    let mut result_index = 0;
    for part in group.iter().flat_map(|message| &message.content) {
        parts.push(match part {
            ContentPart::Text(text) => json!({"text":text}),
            ContentPart::ToolCall(call) => json!({"functionCall":{"id":call.id,"name":call.name,"args":call.arguments}}),
            ContentPart::ToolResult(result) => {
                let mut function = json!({"name":result.name,"response":tool_json(result)});
                // 是否存在原生 ID 由原调用决定，不根据本地 ID 的字面前缀猜测。
                if let Some(id) = native_call_id(request, &result.call_id)? { function["id"] = json!(id); }
                result_index += 1;
                if !result.media.is_empty() {
                    attachments.push(json!({"text":format!("本轮第 {result_index} 个工具结果（{}）的媒体附件",result.name)}));
                    attachments.extend(result.media.iter().map(|item| media::encode(Protocol::Gemini, item.as_ref())).collect::<Result<Vec<_>, _>>()?);
                }
                json!({"functionResponse":function})
            }
            ContentPart::Image(image) => media::encode(Protocol::Gemini, MediaRef::Image(image))?,
            ContentPart::Audio(audio) => media::encode(Protocol::Gemini, MediaRef::Audio(audio))?,
            ContentPart::Video(video) => media::encode(Protocol::Gemini, MediaRef::Video(video))?,
            ContentPart::Reasoning(_) => return Err(Error::Unsupported("Gemini 推理续轮需要原始 thoughtSignature".into())),
        });
    }
    parts.extend(attachments);
    Ok(parts)
}

pub(super) fn response(config: &ModelConfig, body: Value) -> Result<ModelResponse, Error> {
    if body["promptFeedback"]["blockReason"].is_string() {
        return Ok(ModelResponse {
            message: assistant(config, Vec::new(), json!([])),
            finish_reason: FinishReason::ContentFilter,
            usage: usage(&body["usageMetadata"]),
            response_id: body["responseId"].as_str().map(str::to_owned),
        });
    }
    let candidates = array(&body, "candidates")?;
    if candidates.len() != 1 {
        return Err(Error::Protocol("Gemini 必须返回一个候选".into()));
    }
    let candidate = &candidates[0];
    validate_model_role(candidate["content"].get("role"), "model")?;
    let raw = candidate["content"]["parts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut content = Vec::new();
    let identity = uuid::Uuid::new_v4();
    for (index, part) in raw.iter().enumerate() {
        if let Some(text) = part["text"].as_str() {
            content.push(if part["thought"] == true {
                ContentPart::Reasoning(text.into())
            } else {
                ContentPart::Text(text.into())
            });
        }
        if let Some(call) = part.get("functionCall") {
            content.push(ContentPart::ToolCall(ToolCall {
                id: call["id"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("noemori-gemini-{identity}-{index}")),
                name: string(call, "name")?.into(),
                arguments: call.get("args").cloned().unwrap_or_else(|| json!({})),
            }));
        }
        if part.get("text").is_none()
            && part.get("functionCall").is_none()
            && part.get("thoughtSignature").is_none()
        {
            return Err(Error::Unsupported("Gemini 返回了未支持的内容块".into()));
        }
    }
    Ok(ModelResponse {
        finish_reason: finish(
            string(candidate, "finishReason")?,
            content
                .iter()
                .any(|p| matches!(p, ContentPart::ToolCall(_))),
        ),
        message: assistant(config, content, json!(raw)),
        usage: usage(&body["usageMetadata"]),
        response_id: body["responseId"].as_str().map(str::to_owned),
    })
}

fn native_call_id(request: &ModelRequest, id: &str) -> Result<Option<String>, Error> {
    for message in &request.messages {
        if let Some(index) = message.tool_calls().position(|call| call.id == id) {
            return match &message.provider_data {
                Some(data) => {
                    let parts = data
                        .payload
                        .as_array()
                        .ok_or_else(|| Error::Protocol("Gemini 原生消息必须是内容块数组".into()))?;
                    let call = parts
                        .iter()
                        .filter_map(|part| part.get("functionCall"))
                        .nth(index)
                        .ok_or_else(|| Error::Protocol("Gemini 原生调用与消息不匹配".into()))?;
                    Ok(call["id"].as_str().map(str::to_owned))
                }
                None => Ok(Some(id.into())),
            };
        }
    }
    Err(Error::Config("Gemini 工具结果缺少原调用".into()))
}

fn usage(body: &Value) -> Usage {
    Usage {
        input_tokens: body["promptTokenCount"].as_u64(),
        output_tokens: body["candidatesTokenCount"].as_u64(),
        cached_input_tokens: body["cachedContentTokenCount"].as_u64(),
        reasoning_tokens: body["thoughtsTokenCount"].as_u64(),
    }
}

/// 保留原始内容块及其思考签名的关联，候选结束后仅允许补充元数据。
#[derive(Default)]
pub(super) struct StreamState {
    parts: Vec<Value>,
    finish: Option<String>,
    usage: Value,
    id: Option<String>,
    blocked: Option<Value>,
}

impl StreamState {
    pub fn feed(&mut self, body: Value) -> Result<Vec<ModelEvent>, Error> {
        if let Some(id) = body["responseId"].as_str() {
            self.id = Some(id.into());
        }
        if !body["usageMetadata"].is_null() {
            self.usage = body["usageMetadata"].clone();
        }
        if body["promptFeedback"]["blockReason"].is_string() {
            self.blocked = Some(body);
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        if let Some(candidates) = optional_array(&body, "candidates")? {
            if candidates.len() > 1 {
                return Err(Error::Protocol("Gemini 流包含多个候选".into()));
            }
            if let Some(candidate) = candidates.first() {
                validate_model_role(candidate["content"].get("role"), "model")?;
                if let Some(parts) = optional_array(&candidate["content"], "parts")? {
                    if !parts.is_empty() && (self.finish.is_some() || self.blocked.is_some()) {
                        return Err(Error::Protocol("Gemini 候选结束后仍有生成内容".into()));
                    }
                    for part in parts {
                        if let Some(text) = part["text"].as_str() {
                            events.push(if part["thought"] == true {
                                ModelEvent::ReasoningDelta(text.into())
                            } else {
                                ModelEvent::TextDelta(text.into())
                            });
                        }
                        self.parts.push(part.clone());
                    }
                }
                if let Some(reason) = candidate["finishReason"].as_str() {
                    if self
                        .finish
                        .as_deref()
                        .is_some_and(|previous| previous != reason)
                    {
                        return Err(Error::Protocol("Gemini 候选结束后又改变结束原因".into()));
                    }
                    self.finish = Some(reason.into());
                }
            }
        }
        Ok(events)
    }

    pub fn finish(&self, config: &ModelConfig) -> Result<ModelResponse, Error> {
        if let Some(body) = &self.blocked {
            return response(config, body.clone());
        }
        let reason = self
            .finish
            .as_ref()
            .ok_or_else(|| Error::Protocol("Gemini 流缺少 finishReason".into()))?;
        response(
            config,
            json!({"responseId":self.id,"candidates":[{"content":{"parts":self.parts},"finishReason":reason}],"usageMetadata":self.usage}),
        )
    }
}
