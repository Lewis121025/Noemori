use super::*;
use crate::ToolCall;

pub(super) fn request(config: &ModelConfig, request: &ModelRequest) -> Result<Value, Error> {
    let mut contents = Vec::new();
    let mut system = Vec::new();
    for message in &request.messages {
        if message.role == Role::System {
            system.push(json!({"text":text_only(message)?}));
            continue;
        }
        let parts = if let Some(raw) = native(config, message)? {
            raw
        } else {
            let mut parts = Vec::new();
            for part in &message.content {
                parts.push(match part{
                    ContentPart::Text(text)=>json!({"text":text}),
                    ContentPart::ToolCall(call)=>json!({"functionCall":{"id":call.id,"name":call.name,"args":call.arguments}}),
                    ContentPart::ToolResult(result)=>{
                        let mut function=json!({"name":result.name,"response":tool_json(result)});
                        // 是否存在原生 ID 由原调用决定，不根据本地 ID 的字面前缀猜测。
                        if let Some(id) = native_call_id(request, &result.call_id)? { function["id"] = json!(id); }
                        json!({"functionResponse":function})
                    }
                    ContentPart::Reasoning(_)=>return Err(Error::Unsupported("Gemini 推理续轮需要原始 thoughtSignature".into())),
                });
            }
            json!(parts)
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
    Ok(body)
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
                    .unwrap_or_else(|| format!("nous-gemini-{identity}-{index}")),
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
