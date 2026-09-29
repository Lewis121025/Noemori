use super::*;
use crate::ToolCall;

pub(super) fn messages(config: &ModelConfig, request: &ModelRequest) -> Result<Vec<Value>, Error> {
    let mut messages = Vec::new();
    for message in &request.messages {
        if let Some(raw) = native(config, message)? {
            messages.push(raw);
            continue;
        }
        match message.role {
            Role::Tool => for part in &message.content {
                if let ContentPart::ToolResult(result) = part {
                    messages.push(json!({"role":"tool","tool_call_id":result.call_id,"content":tool_json(result).to_string()}));
                }
            },
            Role::Assistant => {
                let calls: Vec<_> = message.tool_calls().map(|call| json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}})).collect();
                let mut raw = json!({"role":"assistant","content":message.text_content()});
                if !calls.is_empty() { raw["tool_calls"] = json!(calls); }
                let reasoning: String = message.content.iter().filter_map(|part| match part { ContentPart::Reasoning(text) => Some(text.as_str()), _ => None }).collect();
                if !reasoning.is_empty() { raw["reasoning_content"] = json!(reasoning); }
                messages.push(raw);
            }
            Role::System | Role::User => messages.push(json!({"role": if message.role == Role::System {"system"} else {"user"},"content":text_only(message)?})),
        }
    }
    Ok(messages)
}

pub(super) fn request(config: &ModelConfig, request: &ModelRequest) -> Result<Value, Error> {
    let mut body = json!({"model":config.model,"messages":messages(config,request)?,"stream":config.capabilities.streaming});
    if !request.tools.is_empty() {
        body["tools"] = json!(tool_definitions(request));
    }
    let token_field = match config.chat_token_limit {
        crate::llm::ChatTokenLimit::MaxTokens => "max_tokens",
        crate::llm::ChatTokenLimit::MaxCompletionTokens => "max_completion_tokens",
    };
    common_options(&mut body, request, token_field);
    if config.capabilities.streaming && config.include_stream_usage {
        body["stream_options"] = json!({"include_usage":true});
    }
    Ok(body)
}

pub(super) fn content(raw: &Value, interrupted: bool) -> Result<Vec<ContentPart>, Error> {
    let mut parts = Vec::new();
    if let Some(text) = raw
        .get("reasoning_content")
        .or_else(|| raw.get("reasoning"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        parts.push(ContentPart::Reasoning(text.into()));
    }
    if let Some(text) = raw
        .get("content")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        parts.push(ContentPart::Text(text.into()));
    }
    if let Some(text) = raw
        .get("refusal")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        parts.push(ContentPart::Text(text.into()));
    }
    if let Some(calls) = optional_array(raw, "tool_calls")? {
        for call in calls {
            if call.get("type").and_then(Value::as_str) != Some("function") {
                return Err(Error::Unsupported("只接受函数工具调用".into()));
            }
            let function = &call["function"];
            let Some(arguments) = complete_arguments(
                function
                    .get("arguments")
                    .ok_or_else(|| Error::Protocol("工具缺少参数".into()))?,
                interrupted,
            )?
            else {
                continue;
            };
            parts.push(ContentPart::ToolCall(ToolCall {
                id: string(call, "id")?.into(),
                name: string(function, "name")?.into(),
                arguments,
            }));
        }
    }
    Ok(parts)
}

pub(super) fn usage(value: &Value) -> Usage {
    Usage {
        input_tokens: value["prompt_tokens"].as_u64(),
        output_tokens: value["completion_tokens"].as_u64(),
        cached_input_tokens: value["prompt_tokens_details"]["cached_tokens"].as_u64(),
        reasoning_tokens: value["completion_tokens_details"]["reasoning_tokens"].as_u64(),
    }
}

pub(super) fn response(config: &ModelConfig, body: Value) -> Result<ModelResponse, Error> {
    let choices = array(&body, "choices")?;
    if choices.len() != 1 {
        return Err(Error::Protocol("一次生成必须返回一个 choice".into()));
    }
    let choice = &choices[0];
    let raw = assistant_payload(
        choice
            .get("message")
            .ok_or_else(|| Error::Protocol("缺少模型消息".into()))?
            .clone(),
    )?;
    let terminal = finish(string(choice, "finish_reason")?, false);
    let parts = content(
        &raw,
        matches!(terminal, FinishReason::Length | FinishReason::ContentFilter),
    )?;
    let reason = finish(
        string(choice, "finish_reason")?,
        parts
            .iter()
            .any(|part| matches!(part, ContentPart::ToolCall(_))),
    );
    Ok(ModelResponse {
        message: assistant(config, parts, raw),
        finish_reason: reason,
        usage: usage(&body["usage"]),
        response_id: body["id"].as_str().map(str::to_owned),
    })
}

/// 按调用索引拼接增量；结束原因封闭生成内容后，仍接收独立的用量尾帧。
#[derive(Default)]
pub(super) struct StreamState {
    message: serde_json::Map<String, Value>,
    calls: std::collections::BTreeMap<usize, Value>,
    finish: Option<String>,
    usage: Value,
    id: Option<String>,
}

impl StreamState {
    pub fn feed(&mut self, body: Value) -> Result<Vec<ModelEvent>, Error> {
        if let Some(id) = body["id"].as_str() {
            self.id = Some(id.into());
        }
        if !body["usage"].is_null() {
            self.usage = body["usage"].clone();
        }
        let choices = array(&body, "choices")?;
        if choices.is_empty() {
            return Ok(Vec::new());
        }
        if self.finish.is_some() {
            return Err(Error::Protocol("Chat 候选结束后仍有生成内容".into()));
        }
        if choices.len() != 1 || choices[0]["index"].as_u64().is_some_and(|value| value != 0) {
            return Err(Error::Protocol("流返回了多个候选".into()));
        }
        let choice = &choices[0];
        let events = match choice.get("delta").filter(|delta| !delta.is_null()) {
            Some(delta) => self.append_delta(delta)?,
            None => Vec::new(),
        };
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish = Some(reason.into());
        }
        Ok(events)
    }

    fn append_delta(&mut self, delta: &Value) -> Result<Vec<ModelEvent>, Error> {
        let delta = delta
            .as_object()
            .ok_or_else(|| Error::Protocol("Chat 增量必须是对象".into()))?;
        validate_assistant_role(delta.get("role"))?;
        let mut events = Vec::new();
        for (key, value) in delta {
            if value.is_null() {
                continue;
            }
            match key.as_str() {
                "reasoning_details" => self.append_reasoning_details(value)?,
                "tool_calls" => {
                    for call in value
                        .as_array()
                        .ok_or_else(|| Error::Protocol("工具增量必须是数组".into()))?
                    {
                        events.extend(self.append_tool_call(call)?);
                    }
                }
                "content" | "refusal" | "reasoning_content" | "reasoning" => {
                    let text = value
                        .as_str()
                        .ok_or_else(|| Error::Protocol("文本增量必须是字符串".into()))?;
                    if let Some(event) = self.append_text(key, text) {
                        events.push(event);
                    }
                }
                _ => {
                    self.message.insert(key.clone(), value.clone());
                }
            }
        }
        Ok(events)
    }

    fn append_tool_call(&mut self, call: &Value) -> Result<Vec<ModelEvent>, Error> {
        if call
            .get("type")
            .is_some_and(|kind| !kind.is_null() && kind != "function")
        {
            return Err(Error::Unsupported("只接受函数工具调用".into()));
        }
        let index = call["index"]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| Error::Protocol("工具增量缺少索引".into()))?;
        let target = self.calls.entry(index).or_insert_with(|| {
            json!({
                "type":"function", "function":{"name":"","arguments":""}
            })
        });
        if let Some(id) = call["id"].as_str() {
            target["id"] = json!(id);
        }
        let mut events = Vec::new();
        for field in ["name", "arguments"] {
            if let Some(text) = call["function"][field].as_str() {
                let current = target["function"][field]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                target["function"][field] = json!(current + text);
                if field == "arguments" {
                    events.push(ModelEvent::ToolCallDelta {
                        index,
                        arguments: text.into(),
                    });
                }
            }
        }
        Ok(events)
    }

    fn append_text(&mut self, field: &str, text: &str) -> Option<ModelEvent> {
        let current = self
            .message
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        self.message.insert(field.into(), json!(current + text));
        if text.is_empty() {
            return None;
        }
        Some(match field {
            "reasoning_content" | "reasoning" => ModelEvent::ReasoningDelta(text.into()),
            _ => ModelEvent::TextDelta(text.into()),
        })
    }

    pub fn finish(&mut self, config: &ModelConfig) -> Result<ModelResponse, Error> {
        let reason = self
            .finish
            .as_ref()
            .ok_or_else(|| Error::Protocol("Chat 流缺少 finish_reason".into()))?;
        self.message.insert("role".into(), json!("assistant"));
        if !self.calls.is_empty() {
            self.message.insert(
                "tool_calls".into(),
                json!(self.calls.values().collect::<Vec<_>>()),
            );
        }
        response(
            config,
            json!({"id":self.id,"choices":[{"message":self.message,"finish_reason":reason}],"usage":self.usage}),
        )
    }

    fn append_reasoning_details(&mut self, value: &Value) -> Result<(), Error> {
        let incoming = value
            .as_array()
            .ok_or_else(|| Error::Protocol("reasoning_details 必须是数组".into()))?;
        if incoming.iter().any(|item| !item.is_object()) {
            return Err(Error::Protocol("推理详情必须是对象".into()));
        }
        // OpenRouter 要求按流顺序回传完整序列，不能用后续分片覆盖旧签名或加密块。
        let details = self
            .message
            .entry("reasoning_details")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| Error::Protocol("推理详情状态不是数组".into()))?;
        details.extend(incoming.iter().cloned());
        Ok(())
    }
}
