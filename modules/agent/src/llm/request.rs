use super::Capabilities;
use crate::{Error, Message, tool::ToolDefinition, validate_history};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 共同生成参数；协议专有配置只在适配器边界合并，不能覆盖消息和工具契约。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GenerationOptions {
    /// 可选非负有限采样温度；供应商的更窄范围由其 API 校验。
    pub temperature: Option<f64>,
    /// 可选核采样阈值，范围为 (0, 1]。
    pub top_p: Option<f64>,
    /// 可选正整数输出预算，映射到所选协议的 token 限额字段。
    pub max_output_tokens: Option<u32>,
    /// 专有请求参数，不得覆盖消息、工具、路由和公共生成参数。
    #[serde(default)]
    pub provider_options: Map<String, Value>,
}

/// 一次模型请求；工具字段只包含声明，不包含可执行代码。
#[derive(Clone, Debug)]
pub struct ModelRequest {
    /// 已闭合的历史，工具调用必须拥有名称和 ID 匹配的结果。
    pub messages: Vec<Message>,
    /// 本次允许模型选择的工具声明，不包含执行函数。
    pub tools: Vec<ToolDefinition>,
    /// 本次请求的公共与供应商专有生成参数。
    pub options: GenerationOptions,
}

impl ModelRequest {
    /// 用消息历史创建不带工具或参数覆盖的请求。
    pub fn new(messages: Vec<Message>) -> Self {
        Self {
            messages,
            tools: Vec::new(),
            options: GenerationOptions::default(),
        }
    }

    /// 在网络请求前检查历史、参数和模型能力。
    ///
    /// # 错误
    /// 非有限数、非法预算、重复工具或不支持的工具请求被明确拒绝。
    pub fn validate(&self, capabilities: Capabilities) -> Result<(), Error> {
        validate_history(&self.messages)?;
        if self
            .options
            .temperature
            .is_some_and(|v| !v.is_finite() || v < 0.0)
            || self
                .options
                .top_p
                .is_some_and(|v| !v.is_finite() || v <= 0.0 || v > 1.0)
            || self.options.max_output_tokens == Some(0)
        {
            return Err(Error::Config("生成参数范围无效".into()));
        }
        if !self.tools.is_empty() && !capabilities.tools {
            return Err(Error::Unsupported("所选模型未声明工具调用能力".into()));
        }
        let mut names = std::collections::BTreeSet::new();
        for tool in &self.tools {
            tool.validate()?;
            if !names.insert(&tool.name) {
                return Err(Error::Config("工具名称重复".into()));
            }
        }
        Ok(())
    }
}
