use super::{AgentEvent, RunReport, runner};
use crate::{
    AgentSession, CancellationToken, Error, ExecutionContext, Message,
    llm::{GenerationOptions, Model, ModelRequest},
    tool::ToolRegistry,
};
use futures::{Stream, StreamExt};
use std::{pin::Pin, sync::Arc, time::Duration};

/// 按消费推进的运行事件流；释放后不再调度模型和工具。
pub type AgentStream = Pin<Box<dyn Stream<Item = AgentEvent> + Send>>;

/// 运行策略；每次模型请求都计入预算，包括重试。
#[derive(Clone, Debug)]
pub struct RunOptions {
    /// 整个运行允许调度的请求数，包含初次请求和重试；零表示不调度。
    pub max_model_calls: usize,
    /// 同一轮尚未产生事件时允许的重试次数，成功响应后重新计算。
    pub max_retries: usize,
    /// 从创建运行流开始计算的总时间预算，必须为可表示的正时长。
    pub timeout: Duration,
    /// 服务商未提供等待提示时的重试间隔，实际等待不超过剩余运行预算。
    pub retry_delay: Duration,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            max_model_calls: 8,
            max_retries: 2,
            timeout: Duration::from_secs(300),
            retry_delay: Duration::from_millis(250),
        }
    }
}

/// 每次运行独占的输入；父取消信号不会因单次运行结束而被取消。
#[derive(Clone, Debug)]
pub struct RunInput {
    /// 对话资源归属；跨轮复用同一会话，关闭对话时由宿主调用 close。
    pub session: AgentSession,
    /// 交给本次运行独占的完整历史，启动前校验工具调用是否闭合。
    pub messages: Vec<Message>,
    /// 每一轮共用的生成参数，工具声明由 Agent 的注册快照提供。
    pub generation: GenerationOptions,
    /// 调用方持有的父取消信号；运行结束不反向取消它。
    pub cancellation: CancellationToken,
}

impl RunInput {
    /// 从完整历史创建输入，默认创建独立会话、取消信号和生成参数。
    ///
    /// 同一对话跨轮运行时应将 session 替换为宿主持有的同一 AgentSession 克隆。
    pub fn new(messages: Vec<Message>) -> Self {
        Self {
            session: AgentSession::new(),
            messages,
            generation: GenerationOptions::default(),
            cancellation: CancellationToken::new(),
        }
    }
}

/// 可复用的 Agent 配置；历史仅存在于单次运行中。
#[derive(Clone)]
pub struct Agent {
    pub(super) model: Arc<dyn Model>,
    pub(super) tools: ToolRegistry,
    pub(super) options: RunOptions,
}

impl Agent {
    /// 返回本轮冻结的模型能力，宿主用它在接受媒体补充前核对当前运行。
    pub(crate) fn capabilities(&self) -> crate::llm::Capabilities {
        self.model.capabilities()
    }

    /// 宿主在发布启动或同轮补充前使用相同请求构造与校验，避免先接受后发现预算超限。
    pub(crate) fn validate_request(
        &self,
        messages: &[Message],
        generation: &GenerationOptions,
    ) -> Result<(), Error> {
        self.model.validate_request(&ModelRequest {
            messages: super::browser_history::for_model(messages, self.model.capabilities().vision),
            tools: self.tools.definitions(),
            options: generation.clone(),
        })
    }

    /// 绑定模型、工具快照与预算；不会发送模型请求。
    ///
    /// `model` 与工具实现可被多个运行共享，`options` 约束每次运行。
    /// 返回不持有对话历史的 Agent，具体输入由后续的 run 或 stream 提供。
    ///
    /// # 错误
    /// 超时非法或模型不支持已注册工具时返回错误。
    pub fn new(
        model: Arc<dyn Model>,
        tools: ToolRegistry,
        options: RunOptions,
    ) -> Result<Self, Error> {
        ExecutionContext::new(CancellationToken::new(), options.timeout)?;
        if !tools.definitions().is_empty() && !model.capabilities().tools {
            return Err(Error::Unsupported(
                "Agent 注册了工具，但模型未声明工具能力".into(),
            ));
        }
        Ok(Self {
            model,
            tools,
            options,
        })
    }

    /// 创建运行流；开始消费后才执行模型和工具，完成时发出唯一 RunReport。
    ///
    /// `input` 包含本次历史、生成参数和父取消信号；返回按消费推进的事件流。
    /// 丢弃流会释放本次工作，此时无法再通过该流取得结束报告。
    ///
    /// # 错误
    /// 输入不合法在启动前返回；启动后的失败保留在最终运行报告中。
    pub fn stream(&self, input: RunInput) -> Result<AgentStream, Error> {
        self.prepare_stream(input, None, None)
    }

    /// 桌面宿主为同一轮提供补充通道；普通运行不创建或共享输入队列。
    pub(crate) fn stream_with_control(
        &self,
        input: RunInput,
        control: super::RunControl,
        pending: Option<super::PendingTurn>,
    ) -> Result<AgentStream, Error> {
        self.prepare_stream(input, Some(control), pending)
    }

    fn prepare_stream(
        &self,
        input: RunInput,
        control: Option<super::RunControl>,
        pending: Option<super::PendingTurn>,
    ) -> Result<AgentStream, Error> {
        self.validate_request(&input.messages, &input.generation)?;
        if let Some(pending) = &pending {
            pending.validate()?;
            if let Some(response) = &pending.response {
                let used: std::collections::BTreeSet<_> = input
                    .messages
                    .iter()
                    .flat_map(|message| message.tool_calls())
                    .map(|call| &call.id)
                    .collect();
                if response
                    .message
                    .tool_calls()
                    .any(|call| used.contains(&call.id))
                {
                    return Err(Error::Protocol("恢复节点重复包含已经提交的工具调用".into()));
                }
            }
        }
        let context =
            ExecutionContext::new(input.cancellation.child_token(), self.options.timeout)?;
        let lease = input.session.register(context.cancellation.clone())?;
        Ok(runner::drive(
            self.clone(),
            input,
            context,
            lease,
            control,
            pending,
        ))
    }

    /// 消费与 stream 相同的执行路径，返回完整运行报告。
    ///
    /// # 错误
    /// 输入校验失败返回错误；运行中的取消、超时和故障由报告状态表达。
    pub async fn run(&self, input: RunInput) -> Result<RunReport, Error> {
        let mut stream = self.stream(input)?;
        while let Some(event) = stream.next().await {
            if let AgentEvent::Finished(report) = event {
                return Ok(*report);
            }
        }
        Err(Error::Protocol("Agent 运行缺少终态报告".into()))
    }
}
