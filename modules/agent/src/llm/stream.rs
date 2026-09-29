use super::ModelResponse;

/// 模型生成增量；只有 Finished 中的完整调用能够进入工具执行阶段。
#[derive(Clone, Debug)]
pub enum ModelEvent {
    /// 可见文本增量。
    TextDelta(String),
    /// 服务商实际返回的推理增量。
    ReasoningDelta(String),
    /// 工具参数增量，仅供进度显示；index 标识本轮调用。
    ToolCallDelta {
        /// 本轮中的调用索引，不是回传工具结果使用的调用 ID。
        index: usize,
        /// 尚未闭合的 JSON 片段，只供显示或诊断，禁止执行。
        arguments: String,
    },
    /// 已完成协议校验的响应，必须是该流的最后一个事件。
    Finished(Box<ModelResponse>),
}

impl ModelEvent {
    /// 构造完成事件；完整响应独立分配，避免每个小增量都占据完整响应大小。
    pub fn finished(response: ModelResponse) -> Self {
        Self::Finished(Box::new(response))
    }
}
