//! UI 连接与动作回执的稳定序列化契约。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// RPC 失败区分未派发与可能已产生副作用，不以取消外层等待冒充回滚。
#[derive(Debug, thiserror::Error)]
pub enum UiRpcError {
    /// 权限、输入、连接或预算在派发前拒绝。
    #[error("{0}")]
    NotExecuted(String),
    /// 已发出动作但尚未确认结算。
    #[error("{0}")]
    Unknown(String),
}
impl UiRpcError {
    /// 返回应呈现给模型的真实阶段，不触发动作重试。
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::NotExecuted(_) => "not_executed",
            Self::Unknown(_) => "unknown",
        }
    }
}
/// 包括取消后迟到结算的回执，正文与本地私有路径不进入该记录。
#[derive(Clone, Debug, Serialize)]
pub struct UiReceipt {
    /// 唯一后端操作标识。
    pub id: String,
    /// 实际后端。
    pub backend: String,
    /// 已派发的动作名称。
    pub action: String,
    /// 未确认、未执行、已观察或已执行。
    pub outcome: String,
    /// 是否仍等待后端结算。
    pub pending: bool,
    /// 明确失败原因。
    pub error: Option<String>,
}
/// 可信构建产物写入的连接定位；不可由模型指定或通过网页读取。
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionConfig {
    /// 本用户私有本地 socket。
    pub socket: PathBuf,
    /// 当前应用进程的随机密钥。
    pub token: String,
    /// 固定扩展身份，只供 Native Messaging 桥接进程核验。
    pub extension_id: String,
}

/// 界面可见的连接与共享标签页，不包含密钥或控制协议。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UiConnection {
    /// 不透明连接标识。
    pub id: String,
    /// chrome、edge 或 computer。
    pub backend: String,
    /// 用户提供的连接名称。
    pub name: String,
    /// 当前连接状态；断开后不能自动重获控制。
    pub connected: bool,
    /// 本会话已共享的标签页。
    pub tabs: Vec<Value>,
    /// 人工接管时停止输入。
    pub human: bool,
}
