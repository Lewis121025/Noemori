//! Responses 解码和续轮共用输出契约；原生扩展字段随消息保留，不从展示文本重建。

use super::super::{complete_arguments, string};
use crate::{ContentPart, Error, ToolCall};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 模型输出消息只接受 assistant，避免统一角色覆盖掩盖服务商的错误报文。
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum OutputRole {
    Assistant,
}

/// 正文与拒绝保持原生类型；签名、注解及服务商扩展字段不能在回放时被裁掉。
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum OutputContent {
    OutputText {
        text: String,
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    Refusal {
        refusal: String,
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    #[serde(other)]
    Unsupported,
}

/// 推理摘要是可展示文本，其他推理字段由服务商拥有并原样回放。
#[derive(Deserialize, Serialize)]
pub(super) struct ReasoningSummary {
    text: String,
    #[serde(flatten)]
    fields: Map<String, Value>,
}

/// 输出项同时负责解码和请求回放；仅正文、角色及工具关联由客户端解释。
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum OutputItem {
    Message {
        #[serde(default)]
        role: Option<OutputRole>,
        content: Vec<OutputContent>,
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    FunctionCall {
        call_id: String,
        name: String,
        arguments: String,
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    Reasoning {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<Vec<ReasoningSummary>>,
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    #[serde(other)]
    Unsupported,
}

impl OutputItem {
    /// 在丢弃报文结构前校验核心字段；未知输出不能静默变成成功文本。
    /// `value` 为原生输出项，返回解码后的契约；字段错误返回协议错误，未知类型返回不支持错误。
    pub(super) fn decode(value: &Value) -> Result<Self, Error> {
        let item = Self::deserialize(value)
            .map_err(|error| Error::Protocol(format!("Responses 输出项无效：{error}")))?;
        match &item {
            Self::Unsupported => {
                return Err(Error::Unsupported(format!(
                    "Responses 输出项：{}",
                    string(value, "type")?
                )));
            }
            Self::Message { content, .. } => {
                if let Some(index) = content
                    .iter()
                    .position(|part| matches!(part, OutputContent::Unsupported))
                {
                    return Err(Error::Unsupported(format!(
                        "Responses 内容类型：{}",
                        string(&value["content"][index], "type")?
                    )));
                }
            }
            _ => {}
        }
        Ok(item)
    }

    /// 从同一输出契约提取通用内容；截断的参数不构造成可执行工具。
    /// `interrupted` 表示长度或过滤终止，返回有序内容；完整响应的非法工具 JSON 返回协议错误。
    pub(super) fn content(&self, interrupted: bool) -> Result<Vec<ContentPart>, Error> {
        match self {
            Self::Message { content, .. } => content
                .iter()
                .map(|part| match part {
                    OutputContent::OutputText { text, .. } => Ok(ContentPart::Text(text.clone())),
                    OutputContent::Refusal { refusal, .. } => {
                        Ok(ContentPart::Text(refusal.clone()))
                    }
                    OutputContent::Unsupported => {
                        Err(Error::Unsupported("Responses 内容类型不支持".into()))
                    }
                })
                .collect(),
            Self::FunctionCall {
                call_id,
                name,
                arguments,
                ..
            } => {
                let Some(arguments) =
                    complete_arguments(&Value::String(arguments.clone()), interrupted)?
                else {
                    return Ok(Vec::new());
                };
                Ok(vec![ContentPart::ToolCall(ToolCall {
                    id: call_id.clone(),
                    name: name.clone(),
                    arguments,
                })])
            }
            Self::Reasoning { summary, .. } => Ok(summary
                .iter()
                .flatten()
                .map(|part| ContentPart::Reasoning(part.text.clone()))
                .collect()),
            Self::Unsupported => Err(Error::Unsupported("Responses 输出项不支持".into())),
        }
    }

    /// 回放输出类型及完整扩展字段；消息和调用的生成 ID、状态不属于输入契约。
    /// 消费已解码的输出项并返回请求 JSON；未知项或序列化失败返回明确错误。
    pub(super) fn into_input(mut self) -> Result<Value, Error> {
        match &mut self {
            Self::Message { role, fields, .. } => {
                *role = Some(OutputRole::Assistant);
                fields.remove("id");
                fields.remove("status");
            }
            Self::FunctionCall { fields, .. } => {
                fields.remove("id");
                fields.remove("status");
            }
            Self::Reasoning { .. } => {}
            Self::Unsupported => return Err(Error::Unsupported("Responses 输出项不支持".into())),
        }
        serde_json::to_value(self)
            .map_err(|error| Error::Protocol(format!("Responses 续轮编码失败：{error}")))
    }
}
