use super::{Fixture, bedrock_fixture};
use noemori_agent::llm::Protocol;
use serde_json::{Value, json};

/// 当前配置入口的完整协议集合，使新增协议时能明确扩展切换验收范围。
pub(super) const PROTOCOLS: [(Protocol, &str); 7] = [
    (Protocol::OpenAiChat, "openai-chat"),
    (Protocol::OpenAiResponses, "openai-responses"),
    (Protocol::Anthropic, "anthropic"),
    (Protocol::VertexAnthropic, "vertex-anthropic"),
    (Protocol::Gemini, "gemini"),
    (Protocol::Ollama, "ollama"),
    (Protocol::Bedrock, "bedrock"),
];

/// 每种协议返回自己的推理、正文和工具格式，确保切换测试不会绕过原生解码。
/// `protocol` 决定报文契约，`streaming` 决定传输格式，`label` 区分签名归属，`tools` 控制终端调用。
/// 返回无需外部模型服务的 HTTP 响应夹具；内部夹具缺少约定字段时恐慌，使测试立即失败。
pub(super) fn fixture(protocol: Protocol, streaming: bool, label: &str, tools: bool) -> Fixture {
    with_body(protocol, streaming, response_body(protocol, label, tools))
}

/// 自定义报文仍经过真实协议的流编码，供异常字段与中断节点测试共用。
pub(super) fn with_body(protocol: Protocol, streaming: bool, body: Value) -> Fixture {
    if !streaming {
        return Fixture::json(body);
    }
    match protocol {
        Protocol::OpenAiChat => chat_stream(body),
        Protocol::OpenAiResponses => Fixture::sse(
            vec![json!({"type":"response.completed", "response":body})],
            false,
        ),
        Protocol::Anthropic | Protocol::VertexAnthropic => anthropic_stream(body),
        Protocol::Gemini => Fixture::sse(vec![body], false),
        Protocol::Ollama => Fixture {
            status: 200,
            content_type: "application/x-ndjson",
            body: format!("{body}\n").into_bytes(),
        },
        Protocol::Bedrock => bedrock_stream(body),
    }
}

fn chat_stream(body: Value) -> Fixture {
    let mut delta = body["choices"][0]["message"].clone();
    if let Some(calls) = delta["tool_calls"].as_array_mut() {
        for (index, call) in calls.iter_mut().enumerate() {
            call["index"] = json!(index);
        }
    }
    Fixture::sse(
        vec![json!({"choices":[{"index":0, "delta":delta,
            "finish_reason":body["choices"][0]["finish_reason"]}]})],
        true,
    )
}

fn response_body(protocol: Protocol, label: &str, tools: bool) -> Value {
    let text = format!("{label}-回答");
    let reasoning = format!("{label}-推理记录");
    let signature = format!("{label}-私有签名");
    let id = format!("{label}-call");
    let arguments = json!({"action":"list"});
    match protocol {
        Protocol::OpenAiChat => {
            let mut message = json!({"role":"assistant", "content":text,
                "reasoning_content":reasoning,
                "reasoning_details":[{"type":"reasoning.encrypted", "data":signature}]});
            if tools {
                message["tool_calls"] = json!([{"id":id, "type":"function",
                    "function":{"name":"terminal", "arguments":arguments.to_string()}}]);
            }
            json!({"choices":[{"message":message,
                "finish_reason":if tools {"tool_calls"} else {"stop"}}]})
        }
        Protocol::OpenAiResponses => {
            let mut output = vec![
                json!({"type":"reasoning", "id":format!("{label}-reasoning"),
                    "summary":[{"type":"summary_text", "text":reasoning}],
                    "encrypted_content":signature}),
                json!({"type":"message", "role":"assistant",
                    "phase":if tools {"commentary"} else {"final_answer"},
                    "content":[{"type":"output_text", "text":text, "annotations":[]}]}),
            ];
            if tools {
                output.push(json!({"type":"function_call", "call_id":id,
                    "name":"terminal", "arguments":arguments.to_string()}));
            }
            json!({"status":"completed", "output":output})
        }
        Protocol::Anthropic | Protocol::VertexAnthropic => {
            let mut content = vec![
                json!({"type":"thinking", "thinking":reasoning, "signature":signature}),
                json!({"type":"text", "text":text}),
            ];
            if tools {
                content.push(json!({"type":"tool_use", "id":id,
                    "name":"terminal", "input":arguments}));
            }
            json!({"role":"assistant", "content":content,
                "stop_reason":if tools {"tool_use"} else {"end_turn"}, "usage":{}})
        }
        Protocol::Gemini => {
            let mut parts = vec![
                json!({"text":reasoning, "thought":true, "thoughtSignature":signature}),
                json!({"text":text}),
            ];
            if tools {
                parts.push(json!({"functionCall":{"id":id, "name":"terminal", "args":arguments}}));
            }
            json!({"candidates":[{"content":{"role":"model", "parts":parts}, "finishReason":"STOP"}]})
        }
        Protocol::Ollama => {
            let mut message = json!({"role":"assistant", "content":text, "thinking":reasoning});
            if tools {
                message["tool_calls"] =
                    json!([{"function":{"name":"terminal", "arguments":arguments}}]);
            }
            json!({"message":message, "done":true, "done_reason":"stop"})
        }
        Protocol::Bedrock => {
            let mut content = vec![
                json!({"reasoningContent":{"reasoningText":{"text":reasoning, "signature":signature}}}),
                json!({"text":text}),
            ];
            if tools {
                content.push(
                    json!({"toolUse":{"toolUseId":id, "name":"terminal", "input":arguments}}),
                );
            }
            json!({"output":{"message":{"role":"assistant", "content":content}},
                "stopReason":if tools {"tool_use"} else {"end_turn"}})
        }
    }
}

fn anthropic_stream(body: Value) -> Fixture {
    let mut events = vec![json!({"type":"message_start",
        "message":{"role":"assistant", "content":[], "usage":{}}})];
    for (index, block) in body["content"].as_array().unwrap().iter().enumerate() {
        events.push(json!({"type":"content_block_start", "index":index, "content_block":block}));
        events.push(json!({"type":"content_block_stop", "index":index}));
    }
    events.push(json!({"type":"message_delta", "delta":{"stop_reason":body["stop_reason"]}}));
    events.push(json!({"type":"message_stop"}));
    Fixture::sse(events, false)
}

fn bedrock_stream(body: Value) -> Fixture {
    let mut events = vec![("messageStart", json!({"role":"assistant"}))];
    for (index, block) in body["output"]["message"]["content"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        if let Some(call) = block.get("toolUse") {
            events.push((
                "contentBlockStart",
                json!({"contentBlockIndex":index,
                "start":{"toolUse":{"toolUseId":call["toolUseId"], "name":call["name"]}}}),
            ));
            events.push((
                "contentBlockDelta",
                json!({"contentBlockIndex":index,
                "delta":{"toolUse":{"input":call["input"].to_string()}}}),
            ));
        } else {
            let delta = if let Some(reasoning) = block.get("reasoningContent") {
                json!({"reasoningContent":reasoning["reasoningText"]})
            } else {
                block.clone()
            };
            events.push((
                "contentBlockDelta",
                json!({"contentBlockIndex":index, "delta":delta}),
            ));
        }
        events.push(("contentBlockStop", json!({"contentBlockIndex":index})));
    }
    events.push(("messageStop", json!({"stopReason":body["stopReason"]})));
    bedrock_fixture(&events)
}
