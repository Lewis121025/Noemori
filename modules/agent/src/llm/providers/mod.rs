//! 原生协议映射；兼容供应商共用协议，品牌差异由端点、认证和专有参数表达。

mod anthropic;
mod bedrock;
mod chat;
mod gemini;
mod ollama;
mod responses;
mod wire;

use super::{FinishReason, ModelConfig, ModelEvent, ModelRequest, ModelResponse, Protocol, Usage};
use crate::{ContentPart, Error, Message, ProviderData, Role};
use serde_json::{Value, json};
pub(super) use wire::Decoder;

pub(super) fn request(config: &ModelConfig, request: &ModelRequest) -> Result<Value, Error> {
    let mut body = match config.protocol {
        Protocol::OpenAiChat => chat::request(config, request),
        Protocol::OpenAiResponses => responses::request(config, request),
        Protocol::Anthropic | Protocol::VertexAnthropic => anthropic::request(config, request),
        Protocol::Gemini => gemini::request(config, request),
        Protocol::Ollama => ollama::request(config, request),
        Protocol::Bedrock => bedrock::request(config, request),
    }?;
    let map = body
        .as_object_mut()
        .ok_or_else(|| Error::Protocol("请求必须为对象".into()))?;
    // 扩展字段不能替换消息、路由、工具或流模式，也不能暗中打开服务商内置工具。
    const RESERVED: &[&str] = &[
        "model",
        "messages",
        "input",
        "contents",
        "system",
        "systemInstruction",
        "instructions",
        "tools",
        "toolConfig",
        "stream",
        "n",
        "candidateCount",
        "previous_response_id",
        "conversation",
        "store",
        "include",
        "generationConfig",
        "inferenceConfig",
        "options",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
        "temperature",
        "top_p",
    ];
    for (key, value) in &request.options.provider_options {
        if merge_nested_options(config.protocol, map, key, value)? {
            continue;
        }
        if RESERVED.contains(&key.as_str()) || map.contains_key(key) {
            return Err(Error::Config(format!("专有参数不能覆盖核心字段：{key}")));
        }
        map.insert(key.clone(), value.clone());
    }
    Ok(body)
}

fn merge_nested_options(
    protocol: Protocol,
    body: &mut serde_json::Map<String, Value>,
    key: &str,
    value: &Value,
) -> Result<bool, Error> {
    let protected: &[&str] = match (protocol, key) {
        (Protocol::Gemini, "generationConfig") => {
            &["temperature", "topP", "maxOutputTokens", "candidateCount"]
        }
        (Protocol::Ollama, "options") => &["temperature", "top_p", "num_predict"],
        (Protocol::Bedrock, "inferenceConfig") => &["temperature", "topP", "maxTokens"],
        _ => return Ok(false),
    };
    let extensions = value
        .as_object()
        .ok_or_else(|| Error::Config(format!("{key} 必须是对象")))?;
    let target = body
        .entry(key)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| Error::Protocol("生成参数必须是对象".into()))?;
    for (name, value) in extensions {
        if protected.contains(&name.as_str()) || target.contains_key(name) {
            return Err(Error::Config(format!(
                "专有参数不能覆盖核心字段：{key}.{name}"
            )));
        }
        target.insert(name.clone(), value.clone());
    }
    Ok(true)
}

pub(super) fn response(config: &ModelConfig, body: Value) -> Result<ModelResponse, Error> {
    if let Some(error) = body.get("error").filter(|v| !v.is_null()) {
        return Err(Error::Protocol(format!("服务商返回错误：{error}")));
    }
    let response = match config.protocol {
        Protocol::OpenAiChat => chat::response(config, body),
        Protocol::OpenAiResponses => responses::response(config, body),
        Protocol::Anthropic | Protocol::VertexAnthropic => anthropic::response(config, body),
        Protocol::Gemini => gemini::response(config, body),
        Protocol::Ollama => ollama::response(config, body),
        Protocol::Bedrock => bedrock::response(config, body),
    }?;
    response.validate()?;
    Ok(response)
}

fn native(config: &ModelConfig, message: &Message) -> Result<Option<Value>, Error> {
    match &message.provider_data {
        None => Ok(None),
        Some(data) if data.protocol == config.protocol.key() && data.model == config.model => {
            let payload = match config.protocol {
                Protocol::OpenAiChat | Protocol::Ollama => assistant_payload(data.payload.clone())?,
                _ => data.payload.clone(),
            };
            Ok(Some(payload))
        }
        Some(_) => Err(Error::Unsupported(
            "历史含其他协议或模型的续轮数据，请显式转换历史".into(),
        )),
    }
}

/// 保存和回放使用同一角色约束，防止原生载荷与统一消息角色相矛盾。
fn assistant_payload(mut payload: Value) -> Result<Value, Error> {
    let object = payload
        .as_object_mut()
        .ok_or_else(|| Error::Protocol("模型消息必须是对象".into()))?;
    validate_assistant_role(object.get("role"))?;
    object.insert("role".into(), json!("assistant"));
    Ok(payload)
}

fn validate_assistant_role(role: Option<&Value>) -> Result<(), Error> {
    if role.is_some_and(|role| !role.is_null() && role != "assistant") {
        return Err(Error::Protocol("模型原生消息角色必须为 assistant".into()));
    }
    Ok(())
}

fn assistant(config: &ModelConfig, content: Vec<ContentPart>, payload: Value) -> Message {
    let data = ProviderData::new(config.protocol.key(), &config.model, payload, &content);
    Message {
        role: Role::Assistant,
        content,
        provider_data: Some(data),
    }
}

fn text_only(message: &Message) -> Result<String, Error> {
    if message
        .content
        .iter()
        .any(|part| !matches!(part, ContentPart::Text(_)))
    {
        return Err(Error::Unsupported("该消息位置只接受文本".into()));
    }
    Ok(message.text_content())
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, Error> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Protocol(format!("缺少字符串字段 {field}")))
}

fn array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, Error> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Protocol(format!("缺少数组字段 {field}")))
}

/// 可选数组把缺失和 null 视为空值，但不吞掉类型错误。
fn optional_array<'a>(value: &'a Value, field: &str) -> Result<Option<&'a Vec<Value>>, Error> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(values)) => Ok(Some(values)),
        Some(_) => Err(Error::Protocol(format!("{field} 必须是数组或 null"))),
    }
}

fn complete_arguments(value: &Value, interrupted: bool) -> Result<Option<Value>, Error> {
    if let Value::String(text) = value {
        return match serde_json::from_str(text) {
            Ok(value) => Ok(Some(value)),
            // 长度或过滤终止时，EOF 是未生成完的参数，不构造成可执行工具。
            Err(error) if interrupted && error.is_eof() => Ok(None),
            Err(error) => Err(Error::Protocol(format!("工具参数不是完整 JSON：{error}"))),
        };
    }
    Ok(Some(value.clone()))
}

fn finish(reason: &str, tools: bool) -> FinishReason {
    match reason {
        "stop" | "end_turn" | "stop_sequence" | "STOP" | "completed" => {
            if tools {
                FinishReason::ToolCalls
            } else {
                FinishReason::Stop
            }
        }
        "tool_calls" | "tool_use" | "function_call" => FinishReason::ToolCalls,
        "length" | "max_tokens" | "MAX_TOKENS" => FinishReason::Length,
        "content_filter"
        | "refusal"
        | "SAFETY"
        | "RECITATION"
        | "BLOCKLIST"
        | "PROHIBITED_CONTENT"
        | "guardrail_intervened" => FinishReason::ContentFilter,
        other => FinishReason::Other(other.into()),
    }
}

fn tool_json(result: &crate::ToolResult) -> Value {
    json!({"output": result.output, "is_error": result.is_error})
}

fn common_options(body: &mut Value, request: &ModelRequest, max_key: &str) {
    for (key, value) in sampling_options(request, "top_p", max_key) {
        body[key] = value;
    }
}

fn sampling_options(
    request: &ModelRequest,
    top_p_key: &str,
    max_key: &str,
) -> serde_json::Map<String, Value> {
    let mut options = serde_json::Map::new();
    if let Some(value) = request.options.temperature {
        options.insert("temperature".into(), json!(value));
    }
    if let Some(value) = request.options.top_p {
        options.insert(top_p_key.into(), json!(value));
    }
    if let Some(value) = request.options.max_output_tokens {
        options.insert(max_key.into(), json!(value));
    }
    options
}

fn tool_definitions(request: &ModelRequest) -> Vec<Value> {
    request.tools.iter().map(|tool| json!({"type":"function", "function":{"name":tool.name,"description":tool.description,"parameters":tool.input_schema}})).collect()
}
