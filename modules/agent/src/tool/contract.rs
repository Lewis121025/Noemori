use crate::ExecutionContext;
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};

/// 工具执行上下文；工具自行启动的工作也必须遵守取消信号和截止时间。
#[derive(Clone, Debug)]
pub struct ToolContext {
    /// 本次调用的唯一关联标识，供工具日志和外部操作记录使用。
    pub call_id: String,
    /// 工具及其自行启动的工作必须共同遵守的取消和截止时间。
    pub execution: ExecutionContext,
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
    /// 执行已校验的参数；返回结果或明确分类的工具失败。
    ///
    /// 实现必须响应上下文中的取消信号，不得把外部任务脱离运行生命周期。
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
