use super::Capabilities;
use crate::Error;
use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::{fmt, sync::Arc, time::Duration};

/// 接口协议，与供应商品牌和模型名称分开配置。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    /// OpenAI 兼容 Chat Completions。
    OpenAiChat,
    /// OpenAI Responses。
    OpenAiResponses,
    /// Anthropic Messages。
    Anthropic,
    /// Vertex 上的 Anthropic Messages，使用 Vertex 请求体和 OAuth 认证。
    VertexAnthropic,
    /// Gemini generateContent / streamGenerateContent。
    Gemini,
    /// Ollama 原生 /api/chat。
    Ollama,
    /// Bedrock Converse / ConverseStream。
    Bedrock,
}

impl Protocol {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai-chat",
            Self::OpenAiResponses => "openai-responses",
            Self::Anthropic => "anthropic",
            Self::VertexAnthropic => "vertex-anthropic",
            Self::Gemini => "gemini",
            Self::Ollama => "ollama",
            Self::Bedrock => "bedrock",
        }
    }
}

/// Chat 兼容端点的输出预算字段；旧兼容服务仍使用 max_tokens。
#[derive(Clone, Copy, Debug, Default)]
pub enum ChatTokenLimit {
    /// 当前 OpenAI Chat 的输出预算。
    #[default]
    MaxCompletionTokens,
    /// 兼容服务常用的输出预算。
    MaxTokens,
}

/// 动态认证边界；可实现凭据刷新或对最终 URL、请求体进行云签名。
#[async_trait]
pub trait RequestAuthenticator: Send + Sync {
    /// 为最终请求添加认证；不得修改模型请求体或路由。
    ///
    /// # 错误
    /// 凭据获取或签名失败时返回错误，请求不会发送。
    async fn authenticate(&self, request: &mut reqwest::Request) -> Result<(), Error>;
}

/// 请求认证；Debug 永远不显示凭据内容。
#[derive(Clone, Default)]
pub enum Authentication {
    /// 本地无鉴权端点。
    #[default]
    None,
    /// Authorization: Bearer。
    Bearer(String),
    /// 例如 x-api-key、api-key、x-goog-api-key。
    Header {
        /// 服务商要求的认证请求头名称，发送前按 HTTP 规则校验。
        name: String,
        /// 凭据原文，加入请求时标记为敏感值。
        value: String,
    },
    /// 调用方提供的动态认证。
    Dynamic(Arc<dyn RequestAuthenticator>),
}

impl fmt::Debug for Authentication {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::None => "None",
            Self::Bearer(_) => "Bearer([redacted])",
            Self::Header { .. } => "Header([redacted])",
            Self::Dynamic(_) => "Dynamic([redacted])",
        })
    }
}

impl Authentication {
    pub(crate) async fn apply(&self, request: &mut reqwest::Request) -> Result<(), Error> {
        let (name, value) = match self {
            Self::None => return Ok(()),
            Self::Dynamic(auth) => return auth.authenticate(request).await,
            Self::Bearer(token) => ("authorization", format!("Bearer {token}")),
            Self::Header { name, value } => (name.as_str(), value.clone()),
        };
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| Error::Config("认证请求头名称无效".into()))?;
        let mut value =
            HeaderValue::from_str(&value).map_err(|_| Error::Config("认证请求头值无效".into()))?;
        value.set_sensitive(true);
        request.headers_mut().insert(name, value);
        Ok(())
    }
}

/// HTTP 模型配置；endpoint 是完整请求 URL，支持云部署路径及本地服务。
#[derive(Clone)]
pub struct ModelConfig {
    /// 决定请求和响应格式，与服务商品牌及模型名称分别配置。
    pub protocol: Protocol,
    /// 服务商接受的模型标识，同时绑定原生续轮数据的归属。
    pub model: String,
    /// 包含操作路径和查询参数的 HTTP(S) URL，不能内嵌用户名或密码。
    pub endpoint: String,
    /// 最终 URL 和请求体确定后应用；动态实现可刷新凭据或签名。
    pub authentication: Authentication,
    /// 额外请求头；同名认证头由 authentication 最后设置。
    pub headers: HeaderMap,
    /// 调用方明确声明的模型能力，不根据模型名称推断。
    pub capabilities: Capabilities,
    /// Chat 协议采用的输出预算字段，其他协议忽略此设置。
    pub chat_token_limit: ChatTokenLimit,
    /// Chat 服务是否接受 stream_options.include_usage。
    pub include_stream_usage: bool,
    /// 单次认证、请求与响应读取的总时间上限，默认 120 秒，且受整个运行预算约束。
    pub request_timeout: Duration,
    /// 完整 JSON 请求体字节上限，默认 20 MB，包含 Base64 和所有历史内容；超限时不发送。
    pub max_request_bytes: usize,
    /// 单次响应的传输字节上限，默认 16 MiB，包含流分帧开销。
    pub max_response_bytes: usize,
}

impl ModelConfig {
    /// 创建配置；模型工具能力默认关闭，由调用方按所选模型明确开启。
    ///
    /// endpoint 使用完整 API 路径；Gemini、Bedrock 会按流模式选择对应操作。
    /// 返回待验证的配置，URL 与时间边界在 HttpModel 构造入口校验。
    pub fn new(protocol: Protocol, model: impl Into<String>, endpoint: impl Into<String>) -> Self {
        Self {
            protocol,
            model: model.into(),
            endpoint: endpoint.into(),
            authentication: Authentication::None,
            headers: HeaderMap::new(),
            capabilities: Capabilities {
                tools: false,
                streaming: true,
                vision: false,
                audio: false,
                video: false,
            },
            chat_token_limit: ChatTokenLimit::default(),
            include_stream_usage: true,
            request_timeout: Duration::from_secs(120),
            max_request_bytes: 20_000_000,
            max_response_bytes: 16 * 1024 * 1024,
        }
    }
}
