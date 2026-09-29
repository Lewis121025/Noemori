use super::*;
use crate::ToolCall;

pub(super) fn request(config: &ModelConfig, request: &ModelRequest) -> Result<Value, Error> {
    let mut input = Vec::new();
    for message in &request.messages {
        if let Some(raw) = native(config, message)? {
            input.extend(
                raw.as_array()
                    .ok_or_else(|| Error::Protocol("Responses 续轮数据必须是输出项数组".into()))?
                    .iter()
                    .cloned(),
            );
            continue;
        }
        for part in &message.content {
            match part {
                ContentPart::Text(text) => {
                    let role = match message.role {
                        Role::System => "system", Role::User => "user", Role::Assistant => "assistant",
                        Role::Tool => return Err(Error::Config("工具消息不能是文本".into())),
                    };
                    input.push(json!({"role": role, "content": text}));
                }
                ContentPart::ToolCall(call) => input.push(json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":call.arguments.to_string()})),
                ContentPart::ToolResult(result) => input.push(json!({"type":"function_call_output","call_id":result.call_id,"output":tool_json(result).to_string()})),
                ContentPart::Reasoning(_) => return Err(Error::Unsupported("Responses 推理续轮需要原生输出项".into())),
            }
        }
    }
    let mut body = json!({"model":config.model,"input":input,"stream":config.capabilities.streaming,"store":false,"include":["reasoning.encrypted_content"]});
    if !request.tools.is_empty() {
        body["tools"] = json!(request.tools.iter().map(|tool|json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.input_schema,"strict":false})).collect::<Vec<_>>());
    }
    common_options(&mut body, request, "max_output_tokens");
    Ok(body)
}

pub(super) fn response(config: &ModelConfig, body: Value) -> Result<ModelResponse, Error> {
    let output = array(&body, "output")?;
    let interrupted = body["status"] == "incomplete";
    let mut content = Vec::new();
    for item in output {
        match string(item, "type")? {
            "message" => {
                for part in array(item, "content")? {
                    match string(part, "type")? {
                        "output_text" => {
                            content.push(ContentPart::Text(string(part, "text")?.into()))
                        }
                        "refusal" => {
                            content.push(ContentPart::Text(string(part, "refusal")?.into()))
                        }
                        other => {
                            return Err(Error::Unsupported(format!("Responses 内容类型：{other}")));
                        }
                    }
                }
            }
            "function_call" => {
                let Some(arguments) = complete_arguments(
                    item.get("arguments")
                        .ok_or_else(|| Error::Protocol("工具缺少参数".into()))?,
                    interrupted,
                )?
                else {
                    continue;
                };
                content.push(ContentPart::ToolCall(ToolCall {
                    id: string(item, "call_id")?.into(),
                    name: string(item, "name")?.into(),
                    arguments,
                }));
            }
            "reasoning" => {
                if let Some(summary) = item["summary"].as_array() {
                    for part in summary {
                        if let Some(text) = part["text"].as_str() {
                            content.push(ContentPart::Reasoning(text.into()));
                        }
                    }
                }
            }
            other => return Err(Error::Unsupported(format!("Responses 输出项：{other}"))),
        }
    }
    let status = string(&body, "status")?;
    let reason = match status {
        "completed" => finish(
            "completed",
            content
                .iter()
                .any(|part| matches!(part, ContentPart::ToolCall(_))),
        ),
        "incomplete" => match body["incomplete_details"]["reason"].as_str() {
            Some("max_output_tokens") => FinishReason::Length,
            Some("content_filter") => FinishReason::ContentFilter,
            other => FinishReason::Other(format!("incomplete:{other:?}")),
        },
        other => FinishReason::Other(other.into()),
    };
    Ok(ModelResponse {
        message: assistant(config, content, json!(output)),
        finish_reason: reason,
        usage: Usage {
            input_tokens: body["usage"]["input_tokens"].as_u64(),
            output_tokens: body["usage"]["output_tokens"].as_u64(),
            cached_input_tokens: body["usage"]["input_tokens_details"]["cached_tokens"].as_u64(),
            reasoning_tokens: body["usage"]["output_tokens_details"]["reasoning_tokens"].as_u64(),
        },
        response_id: body["id"].as_str().map(str::to_owned),
    })
}

pub(super) fn feed(config: &ModelConfig, body: Value) -> Result<Vec<ModelEvent>, Error> {
    let event = string(&body, "type")?;
    Ok(match event {
        "response.output_text.delta" | "response.refusal.delta" => {
            vec![ModelEvent::TextDelta(string(&body, "delta")?.into())]
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            vec![ModelEvent::ReasoningDelta(string(&body, "delta")?.into())]
        }
        "response.function_call_arguments.delta" => vec![ModelEvent::ToolCallDelta {
            index: body["output_index"]
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(|| Error::Protocol("工具增量缺少索引".into()))?,
            arguments: string(&body, "delta")?.into(),
        }],
        "response.completed" | "response.incomplete" => vec![ModelEvent::finished(response(
            config,
            body["response"].clone(),
        )?)],
        "response.failed" | "error" => {
            return Err(Error::Protocol(format!("Responses 流失败：{body}")));
        }
        _ => Vec::new(),
    })
}
