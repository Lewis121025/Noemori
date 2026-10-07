use crate::{
    ContentPart, Role,
    tool::terminal::{
        TerminalApprovalDecision, TerminalApprovalRequest, TerminalInfo,
        TerminalNetworkApprovalDecision, TerminalNetworkApprovalRequest,
    },
};
use serde::{Deserialize, Serialize};

/// 桌面会话的可见消息；供应商原生签名与认证信息不通过此投影交付界面。
#[derive(Clone, Debug, Serialize)]
pub struct HostMessage {
    /// 内容来源。
    pub role: Role,
    /// 界面可见的有序内容。
    pub content: Vec<ContentPart>,
}

/// 运行状态保留取消、预算和基础设施失败的区别。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostRunStatus {
    /// 正在生成或执行工具。
    Running,
    /// 正常完成。
    Completed,
    /// 用户或宿主取消。
    Cancelled,
    /// 整轮超时。
    TimedOut,
    /// 请求预算耗尽。
    BudgetExhausted,
    /// 模型长度截断。
    Truncated,
    /// 内容被过滤。
    Filtered,
    /// 模型、协议或基础设施故障。
    Failed,
}

/// 最近一次运行的只读状态，终端可在该运行结束后继续存活。
#[derive(Clone, Debug, Serialize)]
pub struct HostRunView {
    /// 宿主生成的运行标识。
    pub id: String,
    /// 当前状态。
    pub status: HostRunStatus,
    /// 失败原因；成功不伪造错误。
    pub error: Option<String>,
    /// 已调度请求数量。
    pub model_calls: usize,
}

/// 终端显示元数据；实际字节由独立游标读取，不随会话快照重复复制。
#[derive(Clone, Debug, Serialize)]
pub struct HostTerminal {
    /// 创建终端的实际工具调用。
    pub call_id: String,
    /// 进程状态。
    pub process: TerminalInfo,
    /// 已保存的原始字节数量。
    pub bytes: u64,
    /// 是否为 PTY。
    pub tty: bool,
    /// 记录释放或读取失败的原因。
    pub error: Option<String>,
}

/// 两种审批的完整申请保持原有权限契约，不能从界面输入推导额外授权。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", content = "request", rename_all = "snake_case")]
pub enum HostApprovalRequest {
    /// 当前浏览器会话的精确网络来源。
    Browser(crate::tool::browser::BrowserAccessRequest),
    /// 命令及文件资源。
    Terminal(Box<TerminalApprovalRequest>),
    /// 单个目标主机、端口和协议。
    Network(TerminalNetworkApprovalRequest),
}

/// 宿主生成的待审批标识和不可变申请；窗口重载可重新读取同一申请。
#[derive(Clone, Debug, Serialize)]
pub struct HostApproval {
    /// 本次等待的唯一标识。
    pub id: String,
    /// 实际申请。
    pub request: HostApprovalRequest,
}

/// 界面只能回复已有审批，类型必须与原申请匹配。
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    content = "decision",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum HostApprovalReply {
    /// 浏览器来源授权，不接受终端命令前缀。
    Browser(crate::tool::browser::BrowserAccessDecision),
    /// 命令及文件决定。
    Terminal(TerminalApprovalDecision),
    /// 目标网络决定。
    Network(TerminalNetworkApprovalDecision),
}

/// 桌面会话可恢复的只读投影；读取不消费模型输出、终端日志或审批。
#[derive(Clone, Debug, Serialize)]
pub struct HostSnapshot {
    /// 对话持有的浏览器状态，独立于模型运行生命周期。
    pub browser: crate::tool::browser::BrowserSnapshot,
    /// 宿主生成的会话标识。
    pub id: String,
    /// 已授权工作区。
    pub workspace: String,
    /// 单调更新代次。
    pub revision: u64,
    /// 是否永久关闭。
    pub closed: bool,
    /// 最近运行。
    pub run: Option<HostRunView>,
    /// 所有已观察到的可见消息，未提交结果只用于显示。
    pub messages: Vec<HostMessage>,
    /// 此会话拥有的终端。
    pub terminals: Vec<HostTerminal>,
    /// 当前仍有效的审批。
    pub approvals: Vec<HostApproval>,
}
