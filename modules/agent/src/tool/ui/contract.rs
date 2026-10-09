//! UI 工具输入、输出与会话投影的公共契约。
use super::{
    broker::{self, UiBroker},
    computer::UiAccessRequest,
};
use crate::Image;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// 可信桌面宿主冻结的 UI 运行材料，模型不能替换入口或连接定位。
#[derive(Clone)]
pub struct UiConfig {
    /// QuickJS 独立进程入口。
    pub executable: PathBuf,
    /// 多会话共享的私有本地连接所有者。
    pub broker: UiBroker,
    /// macOS 原生 helper 应用；非 macOS 可以省略。
    pub computer_helper: Option<PathBuf>,
    /// 宿主选择的真实工作区；上传和保存都锚定此目录。
    pub workspace: PathBuf,
}

/// 模型只能运行有界脚本或清空变量，不能替换执行进程与宿主权限。
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(extend("type"="object"))]
pub enum UiInput {
    /// 顶层 await 的全局脚本；跨轮保留标准 JS 词法绑定。
    Run {
        /// 非空 UTF-8 代码，总字节数不超过 64 KiB。
        #[schemars(length(min = 1, max = 65536))]
        code: String,
        /// 单次预算 1–120000 毫秒，仍受 Agent 剩余预算限制。
        #[serde(default = "default_timeout")]
        #[schemars(range(min = 1, max = 120000))]
        timeout_ms: u64,
    },
    /// 仅清空 JS 上下文，不能撤销动作或关闭用户应用。
    Reset,
}
fn default_timeout() -> u64 {
    30000
}

/// 单次脚本结算；脚本失败仍保留已经产生的输出和动作事实。
#[derive(Clone, Debug, Serialize)]
pub struct UiOutput {
    /// print 显式提交的有界 JSON。
    pub prints: Vec<Value>,
    /// 完整错误说明，不能当作动作未执行的证明。
    pub error: Option<String>,
    /// JS 变量是否已清空。
    pub reset: bool,
    /// 本次脚本各 SDK 动作的真实回执。
    pub operations: Vec<Value>,
    /// 图片只在媒体通道发送，不重复序列化字节。
    #[serde(skip)]
    pub images: Vec<Image>,
}

/// 当前对话的活动 UI 状态；不会写入持久化检查点或恢复旧系统句柄。
#[derive(Clone, Debug, Default, Serialize)]
pub struct UiSnapshot {
    /// 执行进程状态，与外部应用控制权分别记录。
    pub status: UiStatus,
    /// JS 上下文代次，硬中断和明确 reset 后递增。
    pub generation: u64,
    /// 当前脚本的宿主标识。
    pub call: Option<String>,
    /// 最近脚本或基础设施错误。
    pub error: Option<String>,
    /// 已共享浏览器和原生 helper 的真实连接。
    pub connections: Vec<broker::UiConnection>,
    /// 包含迟到结算的有界动作记录。
    pub receipts: Vec<broker::UiReceipt>,
    /// 最近由人批准的窗口，恢复时仍须验证实例与窗口身份。
    pub control: Option<UiAccessRequest>,
}
/// 只描述 JS 执行进程，不将用户接管状态与进程故障混为一谈。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UiStatus {
    /// 还未创建执行进程。
    #[default]
    Idle,
    /// 可接受下一条脚本。
    Ready,
    /// 正在执行脚本。
    Busy,
    /// 执行进程或协议故障。
    Failed,
    /// 对话已永久关闭。
    Closed,
}
