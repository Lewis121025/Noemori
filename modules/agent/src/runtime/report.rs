use crate::{
    Error, Message, ToolResult,
    llm::{ModelEvent, ModelResponse, Usage},
};

/// 未提交的一轮；中断时保留已观察内容和已经产生的工具结果。
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingTurn {
    /// 整个模型流已通过完成事件与尾部校验；仅此状态可以恢复工具阶段。
    #[serde(default)]
    pub model_completed: bool,
    /// 已取得的完整响应，缺少完成事件时为空。
    pub response: Option<ModelResponse>,
    /// 完整响应到达前的增量；不能直接当作后续请求历史。
    #[serde(skip)]
    pub deltas: Vec<ModelEvent>,
    /// 按模型调用顺序保留已收到的工具观察，包含业务错误，不会因本轮后续失败丢弃。
    pub tool_results: Vec<ToolResult>,
    /// 已进入执行阶段的调用，未返回结果的调用可能已经产生外部副作用。
    pub attempted_tool_ids: Vec<String>,
}

impl PendingTurn {
    /// 校验恢复节点的响应、尝试记录与观察归属，损坏的检查点不能触发工具执行。
    /// 返回校验结果；响应无效、关联缺失或重复时返回协议错误。
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let calls: std::collections::BTreeMap<_, _> = if let Some(response) = &self.response {
            response.validate()?;
            response
                .message
                .tool_calls()
                .map(|call| (&call.id, &call.name))
                .collect()
        } else {
            Default::default()
        };
        let attempted: std::collections::BTreeSet<_> = self.attempted_tool_ids.iter().collect();
        let mut results = std::collections::BTreeSet::new();
        if attempted.len() != self.attempted_tool_ids.len()
            || (self.model_completed && self.response.is_none())
            || (!self.model_completed && !attempted.is_empty())
            || attempted.iter().any(|id| !calls.contains_key(*id))
            || self
                .deltas
                .iter()
                .any(|delta| matches!(delta, ModelEvent::Finished(_)))
            || self.tool_results.iter().any(|result| {
                !attempted.contains(&result.call_id)
                    || calls
                        .get(&result.call_id)
                        .is_none_or(|name| **name != result.name)
                    || !results.insert(&result.call_id)
            })
        {
            return Err(Error::Protocol("恢复节点的工具关联无效".into()));
        }
        Ok(())
    }
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
    /// 已确认接收但尚未交给模型的真实用户输入，恢复时在当前节点闭合后消费。
    pub pending_inputs: Vec<Message>,
    /// 已调度的请求数，包含重试及调度事件后被取消的请求。
    pub model_calls: usize,
    /// 按模型调用顺序保存已知用量，缺失用量不冒充零。
    pub usage: Vec<Usage>,
}
