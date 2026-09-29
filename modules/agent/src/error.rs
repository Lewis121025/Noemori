//! 错误分类由核心持有，调用方无需解析供应商错误字符串。

use std::time::Duration;

/// 模型接入或运行基础设施失败；工具业务失败另由工具观察表达。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 输入或配置违反契约，未开始执行。
    #[error("配置无效：{0}")]
    Config(String),
    /// 所选模型或协议明确不支持请求能力。
    #[error("能力不支持：{0}")]
    Unsupported(String),
    /// 动态凭据获取或签名失败。
    #[error("模型认证失败：{0}")]
    Authentication(String),
    /// HTTP 连接或读取失败，保留底层原因。
    #[error("模型连接失败：{0}")]
    Transport(#[source] reqwest::Error),
    /// 服务商拒绝请求，保留状态码及重试提示。
    #[error("模型服务返回 HTTP {status}：{message}")]
    Http {
        /// HTTP 状态码。
        status: u16,
        /// 服务商响应摘要。
        message: String,
        /// 服务商建议的等待时间。
        retry_after: Option<Duration>,
    },
    /// 响应不完整或违反协议，不能将部分内容作为成功结果。
    #[error("模型协议错误：{0}")]
    Protocol(String),
    /// 调用方主动结束运行。
    #[error("运行已取消")]
    Cancelled,
    /// 请求、工具或整个运行超过截止时间。
    #[error("运行已超时")]
    Timeout,
    /// 工具依赖的基础设施失效，继续询问模型无法恢复。
    #[error("工具基础设施失败：{0}")]
    ToolInfrastructure(String),
}

impl Error {
    /// 判断尚未输出内容的模型请求能否有限重试；协议失败和取消不可重试。
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Http { status, .. } => matches!(status, 429 | 500 | 502 | 503 | 504),
            Self::Transport(error) => error.is_connect(),
            _ => false,
        }
    }
}
