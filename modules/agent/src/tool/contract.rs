use crate::{AgentSession, ExecutionContext, Media};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};

/// 工具执行上下文；本轮工作遵守运行边界，跨轮工作必须登记到会话资源所有者。
#[derive(Clone, Debug)]
pub struct ToolContext {
    /// 本次调用的唯一关联标识，供工具日志和外部操作记录使用。
    pub call_id: String,
    /// 本轮调用的取消和截止时间；已经登记到会话的跨轮资源由会话负责清理。
    pub execution: ExecutionContext,
    /// 宿主确定的资源归属；模型不得自行指定或切换会话。
    pub session: AgentSession,
}

/// 工具业务失败可交给模型纠正，基础设施失败则终止运行。
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    /// 可作为错误观察反馈给模型的失败。
    #[error("{0}")]
    Execution(String),
    /// 继续生成无法恢复的依赖故障。
    #[error("{0}")]
    Infrastructure(String),
}

/// 宿主工具对同一模型响应内调用的调度约束；默认顺序执行，模型不能自行声明安全性。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolConcurrency {
    /// 等待此前调用结束，并阻止后续调用越过此屏障。
    #[default]
    Sequential,
    /// 允许与相邻的同类调用重叠；实现必须保证不存在顺序依赖或冲突的外部副作用。
    Concurrent,
}

/// 调用方注入的异步工具；注册表负责 Schema 校验及参数反序列化。
#[async_trait]
pub trait Tool: Send + Sync + 'static {
    /// 从同一 Rust 类型生成 Schema，避免声明与执行参数分离。
    type Args: DeserializeOwned + JsonSchema + Send;
    /// 结果必须可序列化为模型能够接收的 JSON。
    type Output: Serialize + Send;

    /// 返回稳定且唯一的工具名称。
    fn name(&self) -> &str;
    /// 描述工具的用途和调用前置条件。
    fn description(&self) -> &str;
    /// 返回此组参数的调度约束；默认保留调用顺序，声明并发是宿主实现的行为保证。
    ///
    /// `args` 来自模型参数，不能仅凭模型的“安全”声明就放开有副作用的操作。
    /// 此方法只能检查参数及已知配置，不能执行外部操作或改变工具状态。
    fn concurrency(&self, _args: &Self::Args) -> ToolConcurrency {
        ToolConcurrency::Sequential
    }
    /// 从完整结果中取得有序媒体观察；默认无附件，媒体与对应结果共同提交。
    ///
    /// `output` 是已成功执行的结果；返回图片、音频或视频，不改变其 JSON 表达。
    /// 若 Output 存有媒体字段，必须使用 serde(skip) 排除，以免字节或引用重复进入工具 JSON。
    fn media(&self, _output: &Self::Output) -> Vec<Media> {
        Vec::new()
    }
    /// 执行已校验的参数；返回结果或明确分类的工具失败。
    ///
    /// 实现必须响应上下文中的取消信号；跨轮任务只能由显式会话接管生命周期。
    /// `args` 已通过 Schema 和反序列化校验，`context` 提供调用归属及运行边界。
    ///
    /// # 错误
    /// 可纠正的业务失败返回 Execution，无法继续运行的依赖故障返回 Infrastructure。
    async fn execute(
        &self,
        args: Self::Args,
        context: ToolContext,
    ) -> Result<Self::Output, ToolError>;
}
