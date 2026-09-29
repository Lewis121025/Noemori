//! 历史以完整消息保存，供应商续轮所需的内容随原消息一起保留。

use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// 消息在对话中的来源。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// 全局约束，仅允许出现在对话开头。
    System,
    /// 用户输入。
    User,
    /// 模型输出。
    Assistant,
    /// 工具观察。
    Tool,
}

/// 模型请求执行的工具；参数为完整 JSON，流式片段不得构造成调用。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// 在整个历史中唯一，用于将结果绑定到原调用；本地合成 ID 不应充当供应商 ID。
    pub id: String,
    /// 与工具声明完全一致的名称，用于校验调用和结果归属。
    pub name: String,
    /// 已完成传输的 JSON；通过工具 Schema 校验后才允许执行。
    pub arguments: Value,
}

/// 工具执行观察；错误观察也必须精确对应调用 ID 和工具名称。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    /// 对应原 ToolCall 的 ID，不能借用其他调用的结果位置。
    pub call_id: String,
    /// 与工具声明完全一致的名称，用于校验调用和结果归属。
    pub name: String,
    /// 工具返回的 JSON，或可供模型纠正的错误观察。
    pub output: Value,
    /// 标记业务执行失败；取消和基础设施故障使用运行终态表达。
    pub is_error: bool,
}

/// 有序的模型内容；推理内容只保留服务商实际提供的部分。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum ContentPart {
    /// 用户可见文本。
    Text(String),
    /// 模型实际返回的推理文本。
    Reasoning(String),
    /// 完整工具调用。
    ToolCall(ToolCall),
    /// 对应某次调用的执行结果。
    ToolResult(ToolResult),
}

/// 适配器拥有的续轮数据；绑定协议及模型，禁止跨协议静默丢弃。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderData {
    pub(crate) protocol: String,
    pub(crate) model: String,
    /// 原生 assistant 消息或输出项，包含签名、加密推理等不可重建字段。
    pub(crate) payload: Value,
    original_content: Vec<ContentPart>,
}

impl ProviderData {
    /// 将原生续轮数据绑定到对应内容快照，避免消息编辑后重放旧数据。
    ///
    /// `protocol` 和 `model` 标识载荷归属，`content` 是该载荷对应的统一内容。
    /// 返回只读载荷与快照；适配器负责保证两者语义一致，本构造函数不解析原生协议。
    pub fn new(
        protocol: impl Into<String>,
        model: impl Into<String>,
        payload: Value,
        content: &[ContentPart],
    ) -> Self {
        Self {
            protocol: protocol.into(),
            model: model.into(),
            payload,
            original_content: content.to_vec(),
        }
    }

    /// 返回所属协议名称，供调用方判断是否可以继续复用。
    pub fn protocol(&self) -> &str {
        &self.protocol
    }

    /// 返回所属模型标识。
    pub fn model(&self) -> &str {
        &self.model
    }

    /// 只读访问原生载荷，防止局部修改破坏其与消息内容的关联。
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub(crate) fn matches(&self, content: &[ContentPart]) -> bool {
        self.original_content == content
    }
}

/// 一条有序消息；协议元数据与其内容共同构成续轮契约。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    /// 约束内容类型，例如工具结果只能位于工具消息中。
    pub role: Role,
    /// 有序内容；修改后必须显式重建或移除原生续轮数据。
    pub content: Vec<ContentPart>,
    /// 签名、加密推理等原生数据，不能跨模型静默复用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_data: Option<ProviderData>,
}

impl Message {
    /// 构造文本消息；角色合法性由运行或模型入口统一校验。
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self {
            role,
            content: vec![ContentPart::Text(text.into())],
            provider_data: None,
        }
    }

    /// 构造工具结果消息，保持调用方给出的结果顺序。
    pub fn tool_results(results: Vec<ToolResult>) -> Self {
        Self {
            role: Role::Tool,
            content: results.into_iter().map(ContentPart::ToolResult).collect(),
            provider_data: None,
        }
    }

    /// 按消息顺序读取工具调用，不复制其参数。
    pub fn tool_calls(&self) -> impl Iterator<Item = &ToolCall> {
        self.content.iter().filter_map(|part| match part {
            ContentPart::ToolCall(call) => Some(call),
            _ => None,
        })
    }

    /// 汇总用户可见文本，不把推理内容或工具参数混入答案。
    pub fn text_content(&self) -> String {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// 校验可发送给模型的完整历史，拒绝孤立结果、重号调用和未完成工具组。
///
/// # 错误
/// 历史为空、消息角色与内容不匹配、工具调用未闭合时返回配置错误。
pub fn validate_history(messages: &[Message]) -> Result<(), Error> {
    if messages.is_empty() {
        return Err(Error::Config("消息历史不能为空".into()));
    }
    let mut pending = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut conversation_started = false;
    for message in messages {
        if message.content.is_empty() && message.provider_data.is_none() {
            return Err(Error::Config("消息内容不能为空".into()));
        }
        if message.role != Role::Tool && !pending.is_empty() {
            return Err(Error::Config("工具结果未齐全，不能开始下一条消息".into()));
        }
        if message.role == Role::System {
            if conversation_started {
                return Err(Error::Config("系统消息必须位于历史开头".into()));
            }
        } else {
            conversation_started = true;
        }
        if message.provider_data.is_some() && message.role != Role::Assistant {
            return Err(Error::Config("原生续轮数据只能附着模型消息".into()));
        }
        if message
            .provider_data
            .as_ref()
            .is_some_and(|data| !data.matches(&message.content))
        {
            return Err(Error::Config(
                "消息内容已修改，必须显式移除或重建原生续轮数据".into(),
            ));
        }
        for part in &message.content {
            match (message.role, part) {
                (Role::Assistant, ContentPart::ToolCall(call)) => {
                    if call.id.is_empty() || call.name.is_empty() || !seen.insert(call.id.clone()) {
                        return Err(Error::Config("工具调用名称或 ID 为空，或 ID 重复".into()));
                    }
                    pending.insert(call.id.clone(), call.name.clone());
                }
                (Role::Tool, ContentPart::ToolResult(result)) => {
                    if pending.remove(&result.call_id).as_deref() != Some(&result.name) {
                        return Err(Error::Config("工具结果与调用不匹配".into()));
                    }
                }
                (Role::System | Role::User | Role::Assistant, ContentPart::Text(_))
                | (Role::Assistant, ContentPart::Reasoning(_)) => {}
                _ => return Err(Error::Config("消息角色与内容不匹配".into())),
            }
        }
    }
    if !pending.is_empty() || !conversation_started {
        return Err(Error::Config("历史缺少对话消息或工具结果".into()));
    }
    Ok(())
}
