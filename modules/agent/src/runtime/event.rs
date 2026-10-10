use super::RunReport;
use crate::{ToolCall, ToolResult, llm::ModelEvent};
use std::time::Duration;

/// 单次运行中的有序事件；工具结束事件先于下一次模型调用。
#[derive(Debug)]
pub enum AgentEvent {
    /// 模型流已经完整结束并通过尾部校验，当前响应可进入工具与历史提交阶段。
    ModelCompleted,
    /// 当前节点已结算，等待用户操作；不代表运行完成或需要新增用户任务。
    Paused,
    /// 用户交还控制，同一运行从已闭合历史继续。
    Resumed,
    /// 已接收的真实用户补充进入下一次模型请求；恢复工具节点时不会提前插入。
    InputsCommitted(Vec<crate::Message>),
    /// 一次模型与工具节点已闭合；from 是提交前的历史长度，messages 仅包含本次增量。
    HistoryCommitted {
        /// 本次增量在完整历史中的起始索引，等于提交前的历史长度。
        from: usize,
        /// 按历史顺序交付本次节点提交的完整消息增量。
        messages: Vec<crate::Message>,
    },
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
    /// 按实际完成顺序发出工具结果；并发时顺序可与调用不同，历史仍按模型调用顺序保存。
    ToolFinished(ToolResult),
    /// 唯一运行终态；之后不会再有事件。
    Finished(Box<RunReport>),
}
