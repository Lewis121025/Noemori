use crate::ExecutionContext;
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 模型可提出但不能自行授予的额外权限；授权范围持续到该进程结束。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TerminalPermissionRequest {
    /// 给宿主或用户的具体申请原因，不能为空。
    #[schemars(length(min = 1, max = 2048))]
    pub reason: String,
    /// 申请额外读取的绝对文件或目录路径，必须已经存在。
    #[serde(default)]
    #[schemars(length(max = 64))]
    pub readable_paths: Vec<PathBuf>,
    /// 申请额外读写的绝对目录路径，必须已经存在。
    #[serde(default)]
    #[schemars(length(max = 64))]
    pub writable_paths: Vec<PathBuf>,
    /// 是否申请允许网络；false 不改变已有权限，受控目标策略不会被此申请改成原始直连。
    #[serde(default)]
    pub network: bool,
}

/// 宿主看到的完整执行申请；批准覆盖该命令创建的整个进程及其后续交互。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalApprovalRequest {
    /// 原始工具调用标识，用于关联宿主审批记录。
    pub call_id: String,
    /// 将要执行的原始 shell 命令。
    pub command: String,
    /// 已解析的绝对工作目录。
    pub workdir: PathBuf,
    /// 是否允许后续 PTY 输入；宿主须将交互权限一起展示和审批。
    pub tty: bool,
    /// 是否开启非 PTY 标准输入；与命令一起审批整个进程的交互能力。
    pub stdin: bool,
    /// 可选的初始 PTY 尺寸。
    pub size: Option<super::TerminalSize>,
    /// 宿主配置的 shell，模型不能替换。
    pub shell: PathBuf,
    /// 实际使用的登录环境语义，可能由宿主已经采集的快照实现。
    pub login: bool,
    /// 已采集的环境快照身份；宿主可据此区分环境变更后的执行申请。
    pub environment_snapshot: Option<String>,
    /// 不包含明文环境值的基础权限指纹；环境或授权改变后不复用旧的资源许可。
    pub policy_fingerprint: String,
    /// 初始化内容的稳定指纹；持久规则可区分工具重启与实际环境变化。
    pub environment_fingerprint: Option<String>,
    /// 命令执行时限；None 表示由显式停止或会话关闭终止。
    pub timeout_ms: Option<u64>,
    /// 请求扩大到的具体权限，不包含关闭系统沙箱的能力。
    pub permissions: TerminalPermissionRequest,
    /// 实际命令规则检查结果；Prompt 要求本次确认，不能被已经保存的资源许可绕过。
    #[cfg(unix)]
    #[serde(default)]
    pub command_policy: Option<super::TerminalCommandEvaluation>,
}

/// 宿主对一次进程授权的决定；拒绝必须提供可反馈给模型的原因。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "decision",
    content = "details",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TerminalApprovalDecision {
    /// 授予本次申请；不会改变工具默认配置或其他进程的权限。
    AllowOnce,
    /// 在当前会话、相同宿主权限与环境下复用已批准的资源范围；关闭会话即撤销。
    AllowForSession,
    /// 本会话允许同一执行上下文中、以指定字面参数开头的单个命令使用此次资源许可。
    AllowPrefix {
        /// 实际命令必须具有此前缀；命令替换、重定向和多个命令不会自动匹配。
        prefix: Vec<String>,
    },
    /// 将同样的前缀授权原子保存到宿主规则库；未配置规则库或保存失败时不执行命令。
    AllowPersistentPrefix {
        /// 宿主确认的字面参数前缀，不能由模型自授。
        prefix: Vec<String>,
    },
    /// 拒绝执行，并返回原因。
    Deny(String),
}

/// 由宿主实现的审批边界；模型只能提交申请，决定来自此接口。
#[async_trait]
pub trait TerminalApprover: Send + Sync + 'static {
    /// 审批不可变的命令与权限申请；等待时必须遵守取消和截止时间。
    ///
    /// `request` 是实际将执行的命令，`context` 约束本次审批等待。
    /// 返回明确的允许或拒绝；审批服务故障返回原因，不会退回自动允许。
    async fn approve(
        &self,
        request: TerminalApprovalRequest,
        context: ExecutionContext,
    ) -> Result<TerminalApprovalDecision, String>;
}
