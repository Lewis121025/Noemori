use super::RunReport;
use crate::{ToolCall, ToolResult, llm::ModelEvent};
use std::time::Duration;

/// 单次运行中的有序事件；工具结束事件先于下一次模型调用。
#[derive(Debug)]
pub enum AgentEvent {
    /// 即将执行一次模型请求，call 从一开始，重试也占用编号。
    ModelStarted {
        /// 从一开始的调度序号，之后仍可能因取消而不进入模型实现。
        call: usize,
    },
    /// 模型协议层的增量或完整响应。
    Model(ModelEvent),
    /// 尚未输出内容的请求允许重试。
    RetryScheduled {
        /// 已受运行剩余预算约束的等待时长。
        after: Duration,
    },
    /// 即将执行完整工具调用。
    ToolStarted(ToolCall),
    /// 已获得工具执行结果，包括可恢复的错误观察。
    ToolFinished(ToolResult),
    /// 唯一运行终态；之后不会再有事件。
    Finished(Box<RunReport>),
}
