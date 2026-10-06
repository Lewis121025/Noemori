use crate::{ContentPart, Error, Message, Role};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// 模型停止原因；未知值保留原文，不能默认判成正常完成。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FinishReason {
    /// 正常完成。
    Stop,
    /// 请求执行工具。
    ToolCalls,
    /// 输出被长度预算截断。
    Length,
    /// 输出受到内容过滤。
    ContentFilter,
    /// 尚未归一化的供应商原因。
    Other(String),
}

/// 服务商明确提供的用量；缺失值保留为空，不伪装成零。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// 服务商报告的输入 token 数；缺失时保持为空，保留其计数口径。
    pub input_tokens: Option<u64>,
    /// 服务商报告的输出 token 数，是否包含推理由相应协议决定。
    pub output_tokens: Option<u64>,
    /// 服务商明确报告的缓存命中量，不从总量推测。
    pub cached_input_tokens: Option<u64>,
    /// 服务商明确报告的推理用量，无法取得时保持为空。
    pub reasoning_tokens: Option<u64>,
}

/// 完整模型响应；原生续轮数据位于 message 内，与可见文本共同保留。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelResponse {
    /// 完整模型消息；截断时只包含已形成完整结构的内容。
    pub message: Message,
    /// 决定能否执行工具或提交历史，不能将截断当作正常结束。
    pub finish_reason: FinishReason,
    /// 当前请求的已知用量，不包含其他请求的累加值。
    pub usage: Usage,
    /// 服务商明确分配的响应标识；没有标识时不能用时间戳或错误原因代替。
    pub response_id: Option<String>,
}

impl ModelResponse {
    /// 验证完整响应的内部契约，工具调用 ID 必须在该响应内唯一。
    ///
    /// # 错误
    /// 非模型消息、空成功响应、重复调用或错误内容类型返回协议错误。
    pub fn validate(&self) -> Result<(), Error> {
        if self.message.role != Role::Assistant {
            return Err(Error::Protocol("模型响应必须是 assistant 消息".into()));
        }
        if self
            .message
            .provider_data
            .as_ref()
            .is_some_and(|data| !data.matches(&self.message.content))
        {
            return Err(Error::Protocol("模型响应与原生续轮数据不匹配".into()));
        }
        let mut ids = BTreeSet::new();
        for part in &self.message.content {
            match part {
                ContentPart::ToolResult(_)
                | ContentPart::Image(_)
                | ContentPart::Audio(_)
                | ContentPart::Video(_) => {
                    return Err(Error::Protocol("模型响应不能包含工具结果或输入媒体".into()));
                }
                ContentPart::ToolCall(call)
                    if call.id.is_empty() || call.name.is_empty() || !ids.insert(&call.id) =>
                {
                    return Err(Error::Protocol("工具调用 ID 或名称无效".into()));
                }
                _ => {}
            }
        }
        if matches!(self.finish_reason, FinishReason::ToolCalls) && ids.is_empty() {
            return Err(Error::Protocol("工具结束原因缺少调用".into()));
        }
        let has_content = self.message.content.iter().any(|part| match part {
            ContentPart::Text(text) | ContentPart::Reasoning(text) => !text.is_empty(),
            ContentPart::ToolCall(_) => true,
            ContentPart::ToolResult(_)
            | ContentPart::Image(_)
            | ContentPart::Audio(_)
            | ContentPart::Video(_) => false,
        });
        if !has_content
            && matches!(
                self.finish_reason,
                FinishReason::Stop | FinishReason::ToolCalls
            )
        {
            return Err(Error::Protocol("模型返回空的成功响应".into()));
        }
        Ok(())
    }
}
