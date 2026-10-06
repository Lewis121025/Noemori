use noemori_agent::llm::{
    Capabilities, FinishReason, Model, ModelEvent, ModelRequest, ModelResponse, ModelStream, Usage,
};
use noemori_agent::{ContentPart, Error, ExecutionContext, Message, Role, ToolCall};
use serde_json::Value;
use std::{collections::VecDeque, sync::Mutex};

/// 按预设顺序返回事件，额外请求会让测试直接失败。
pub struct ScriptedModel {
    scripts: Mutex<VecDeque<Vec<Result<ModelEvent, Error>>>>,
    /// 记录真实进入模型边界的请求，用于检查取消及续轮行为。
    pub requests: Mutex<Vec<ModelRequest>>,
}

impl ScriptedModel {
    /// 每个脚本对应一次请求，允许插入协议或传输故障。
    pub fn new(scripts: Vec<Vec<Result<ModelEvent, Error>>>) -> Self {
        Self {
            scripts: Mutex::new(scripts.into()),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl Model for ScriptedModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tools: true,
            streaming: true,
            vision: false,
            audio: false,
            video: false,
        }
    }
    fn generate(&self, request: ModelRequest, _: ExecutionContext) -> ModelStream {
        self.requests.lock().unwrap().push(request);
        let script = self
            .scripts
            .lock()
            .unwrap()
            .pop_front()
            .expect("发生意外模型请求");
        Box::pin(futures::stream::iter(script))
    }
}

/// 构造可与错误事件放入同一脚本的文本完成事件。
pub fn answer(text: &str) -> Result<ModelEvent, Error> {
    Ok(ModelEvent::finished(ModelResponse {
        message: Message::text(Role::Assistant, text),
        finish_reason: FinishReason::Stop,
        usage: Usage::default(),
        response_id: None,
    }))
}

/// 保留给定调用顺序和关联 ID，用于验证完整工具往返。
pub fn calls(calls: &[(&str, &str, Value)]) -> Result<ModelEvent, Error> {
    Ok(ModelEvent::finished(ModelResponse {
        message: Message {
            role: Role::Assistant,
            content: calls
                .iter()
                .map(|(id, name, args)| {
                    ContentPart::ToolCall(ToolCall {
                        id: (*id).into(),
                        name: (*name).into(),
                        arguments: args.clone(),
                    })
                })
                .collect(),
            provider_data: None,
        },
        finish_reason: FinishReason::ToolCalls,
        usage: Usage::default(),
        response_id: None,
    }))
}
