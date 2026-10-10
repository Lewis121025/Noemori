use super::*;
use crate::ToolCall;

pub(super) fn request(config: &ModelConfig, request: &ModelRequest) -> Result<Value, Error> {
    let mut messages = Vec::new();
    let mut image_messages = Vec::new();
    let mut result_index = 0;
    for message in &request.messages {
        if message.role != Role::Tool {
            messages.append(&mut image_messages);
            result_index = 0;
        }
        if let Some(raw) = native(config, message)? {
            messages.push(raw);
            continue;
        }
        if message.role == Role::Tool {
            for part in &message.content {
                if let ContentPart::ToolResult(result) = part {
                    messages.push(json!({"role":"tool","tool_name":result.name,"content":tool_json(result).to_string()}));
                }
            }
        } else {
            let mut raw = json!({"role":match message.role{Role::System=>"system",Role::User=>"user",_=>"assistant"},"content":message.text_content()});
            let images: Vec<_> = message
                .content
                .iter()
                .flat_map(ContentPart::media)
                .map(|item| media::encode(Protocol::Ollama, item))
                .collect::<Result<Vec<_>, _>>()?;
            if !images.is_empty() {
                raw["images"] = json!(images);
            }
            let calls: Vec<_> = message
                .tool_calls()
                .map(|call| json!({"function":{"name":call.name,"arguments":call.arguments}}))
                .collect();
            if !calls.is_empty() {
                raw["tool_calls"] = json!(calls);
            }
            let thinking: String = message
                .content
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Reasoning(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            if !thinking.is_empty() {
                raw["thinking"] = json!(thinking);
            }
            messages.push(raw);
        }
        if message.role == Role::Tool {
            for part in &message.content {
                if let ContentPart::ToolResult(result) = part {
                    result_index += 1;
                    if !result.media.is_empty() {
                        let images = result
                            .media
                            .iter()
                            .map(|item| media::encode(Protocol::Ollama, item.as_ref()))
                            .collect::<Result<Vec<_>, _>>()?;
                        image_messages.push(json!({"role":"user","content":format!("本轮第 {result_index} 个工具结果（{}）的图片",result.name),"images":images}));
                    }
                }
            }
        }
    }
    messages.append(&mut image_messages);
    let mut body =
        json!({"model":config.model,"messages":messages,"stream":config.capabilities.streaming});
    if !request.tools.is_empty() {
        body["tools"] = json!(tool_definitions(request));
    }
    let options = sampling_options(request, "top_p", "num_predict");
    if !options.is_empty() {
        body["options"] = json!(options);
    }
    if let Some(effort) = &config.reasoning_effort {
        // 原生 think 关闭值是布尔值；命名档位原样发送，不套兼容接口的降档别名。
        body["think"] = match effort.as_str() {
            "none" | "false" => json!(false),
            "true" => json!(true),
            _ => json!(effort),
        };
    }
    Ok(body)
}

pub(super) fn response(config: &ModelConfig, body: Value) -> Result<ModelResponse, Error> {
    if body["done"] != true {
        return Err(Error::Protocol("Ollama 响应缺少 done=true".into()));
    }
    let raw = assistant_payload(
        body.get("message")
            .ok_or_else(|| Error::Protocol("Ollama 缺少 message".into()))?
            .clone(),
    )?;
    let mut content = Vec::new();
    if let Some(text) = raw["thinking"].as_str().filter(|s| !s.is_empty()) {
        content.push(ContentPart::Reasoning(text.into()));
    }
    if let Some(text) = raw["content"].as_str().filter(|s| !s.is_empty()) {
        content.push(ContentPart::Text(text.into()));
    }
    if let Some(calls) = optional_array(&raw, "tool_calls")? {
        let identity = uuid::Uuid::new_v4();
        for (index, call) in calls.iter().enumerate() {
            content.push(ContentPart::ToolCall(ToolCall {
                id: format!("noemori-ollama-{identity}-{index}"),
                name: string(&call["function"], "name")?.into(),
                arguments: call["function"]
                    .get("arguments")
                    .cloned()
                    .ok_or_else(|| Error::Protocol("Ollama 调用缺少参数".into()))?,
            }));
        }
    }
    let reason = finish(
        body["done_reason"].as_str().unwrap_or("stop"),
        content
            .iter()
            .any(|p| matches!(p, ContentPart::ToolCall(_))),
    );
    Ok(ModelResponse {
        message: assistant(config, content, raw),
        finish_reason: reason,
        usage: Usage {
            input_tokens: body["prompt_eval_count"].as_u64(),
            output_tokens: body["eval_count"].as_u64(),
            ..Usage::default()
        },
        response_id: None,
    })
}

/// 聚合逐行响应，在 done 帧到达时统一生成可回放的完整助手消息。
#[derive(Default)]
pub(super) struct StreamState {
    text: String,
    thinking: String,
    calls: Vec<Value>,
}

impl StreamState {
    pub fn feed(
        &mut self,
        config: &ModelConfig,
        mut body: Value,
    ) -> Result<Vec<ModelEvent>, Error> {
        let mut events = Vec::new();
        if let Some(message) = body.get("message").filter(|message| !message.is_null()) {
            let message = message
                .as_object()
                .ok_or_else(|| Error::Protocol("Ollama 消息必须是对象".into()))?;
            validate_model_role(message.get("role"), "assistant")?;
        }
        if let Some(text) = body["message"]["content"].as_str() {
            self.text.push_str(text);
            if !text.is_empty() {
                events.push(ModelEvent::TextDelta(text.into()));
            }
        }
        if let Some(text) = body["message"]["thinking"].as_str() {
            self.thinking.push_str(text);
            if !text.is_empty() {
                events.push(ModelEvent::ReasoningDelta(text.into()));
            }
        }
        if let Some(calls) = optional_array(&body["message"], "tool_calls")? {
            self.calls.extend(calls.iter().cloned());
        }
        if body["done"] == true {
            body["message"] = json!({"role":"assistant","content":self.text});
            if !self.thinking.is_empty() {
                body["message"]["thinking"] = json!(self.thinking);
            }
            if !self.calls.is_empty() {
                body["message"]["tool_calls"] = json!(self.calls);
            }
            events.push(ModelEvent::finished(response(config, body)?));
        }
        Ok(events)
    }
}
