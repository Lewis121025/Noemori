use crate::{
    Error, Message, ToolResult,
    llm::{ModelEvent, ModelResponse, Usage},
};

/// 未提交的一轮；中断时保留已观察内容和已经产生的工具结果。
#[derive(Clone, Debug, Default)]
pub struct PendingTurn {
    /// 已取得的完整响应，缺少完成事件时为空。
    pub response: Option<ModelResponse>,
    /// 完整响应到达前的增量；不能直接当作后续请求历史。
    pub deltas: Vec<ModelEvent>,
    /// 已经收到的工具观察，包含业务错误，不会因本轮后续失败丢弃。
    pub tool_results: Vec<ToolResult>,
    /// 已进入执行阶段的调用，未返回结果的调用可能已经产生外部副作用。
    pub attempted_tool_ids: Vec<String>,
}

/// 运行终态；所有非正常终态均保留已有历史和未提交步骤。
#[derive(Debug)]
pub enum RunStatus {
    /// 正常完成。
    Completed,
    /// 调用方主动取消。
    Cancelled,
    /// 截止时间已到。
    TimedOut,
    /// 模型调用预算耗尽。
    BudgetExhausted,
    /// 模型输出被长度限制截断。
    Truncated,
    /// 模型内容被过滤。
    Filtered,
    /// 协议、服务商或基础设施失败。
    Failed(Error),
}

impl RunStatus {
    pub(super) fn from_error(error: Error) -> Self {
        match error {
            Error::Cancelled => Self::Cancelled,
            Error::Timeout => Self::TimedOut,
            other => Self::Failed(other),
        }
    }
}

/// 单次运行结果；history 始终是闭合对话，pending_turn 不会被自动重放。
#[derive(Debug)]
pub struct RunReport {
    /// 唯一终态，调用方必须区分完成、取消、截断和失败。
    pub status: RunStatus,
    /// 已提交且工具调用关系闭合的历史，可作为下一次运行的输入。
    pub history: Vec<Message>,
    /// 尚未提交的当前轮次，不能直接拼入历史或自动重放。
    pub pending_turn: Option<PendingTurn>,
    /// 已调度的请求数，包含重试及调度事件后被取消的请求。
    pub model_calls: usize,
    /// 按模型调用顺序保存已知用量，缺失用量不冒充零。
    pub usage: Vec<Usage>,
}
