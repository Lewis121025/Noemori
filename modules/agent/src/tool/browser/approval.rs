use crate::ExecutionContext;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// 授权只扩展指定来源的网络可达性，不代表批准网站内的业务操作。
#[derive(Clone, Debug, Serialize)]
pub struct BrowserAccessRequest {
    /// 精确到协议、主机和端口的来源。
    pub origin: String,
    /// 用户需要判断的访问用途。
    pub reason: String,
}

/// 浏览器可持续发起子资源请求，因此来源授权明确限定为整个会话。
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "decision",
    content = "details",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum BrowserAccessDecision {
    /// 当前会话允许该来源，关闭后失效。
    AllowForSession,
    /// 拒绝访问并保留原因。
    Deny(String),
}

/// 权限决定必须由可信宿主提供；网页内容和模型参数不能代替用户决定。
#[async_trait]
pub trait BrowserApprover: Send + Sync {
    /// 按 request 等待可信宿主的来源决定；context 限制取消与截止时间。
    /// 返回会话授权或拒绝原因；取消或审批通道故障时返回错误，不授予权限。
    async fn approve(
        &self,
        request: BrowserAccessRequest,
        context: ExecutionContext,
    ) -> Result<BrowserAccessDecision, String>;
}
