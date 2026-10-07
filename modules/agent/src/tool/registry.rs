use super::{Tool, ToolConcurrency, ToolContext, ToolDefinition, ToolError};
use crate::{AgentSession, Error, ExecutionContext, Media, ToolCall, ToolResult};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

/// 在异构注册表内统一调用入口，具体参数和返回值仍由各工具的类型契约约束。
trait ErasedTool: Send + Sync {
    fn prepare(&self, args: Value) -> Result<Box<dyn Invocation + '_>, ToolError>;
}

/// 调度与执行共用一次反序列化后的参数；拥有参数直到执行结束或取消。
#[async_trait]
trait Invocation: Send {
    fn concurrency(&self) -> ToolConcurrency;
    async fn call(self: Box<Self>, context: ToolContext) -> Result<(Value, Vec<Media>), ToolError>;
}

/// 在 JSON 边界完成序列化转换，使工具实现保留强类型参数和返回值。
struct TypedTool<T>(T);

impl<T: Tool> ErasedTool for TypedTool<T> {
    fn prepare(&self, args: Value) -> Result<Box<dyn Invocation + '_>, ToolError> {
        let args = serde_json::from_value(args)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        Ok(Box::new(TypedInvocation {
            tool: &self.0,
            args,
        }))
    }
}

struct TypedInvocation<'a, T: Tool> {
    tool: &'a T,
    args: T::Args,
}

#[async_trait]
impl<T: Tool> Invocation for TypedInvocation<'_, T> {
    fn concurrency(&self) -> ToolConcurrency {
        self.tool.concurrency(&self.args)
    }

    async fn call(self: Box<Self>, context: ToolContext) -> Result<(Value, Vec<Media>), ToolError> {
        let output = self.tool.execute(self.args, context).await?;
        let media = self.tool.media(&output);
        for attachment in &media {
            attachment
                .validate()
                .map_err(|error| ToolError::Execution(error.to_string()))?;
        }
        let value = serde_json::to_value(output)
            .map_err(|error| ToolError::Infrastructure(error.to_string()))?;
        Ok((value, media))
    }
}

/// 将声明、编译后的参数校验器和实现绑定，保证模型所见契约与实际执行一致。
struct Entry {
    definition: ToolDefinition,
    validator: jsonschema::Validator,
    tool: Box<dyn ErasedTool>,
}

/// 可克隆的工具集合；克隆形成独立注册快照，共享工具实现，其内部状态由工具自行同步。
#[derive(Clone, Default)]
pub struct ToolRegistry {
    entries: BTreeMap<String, Arc<Entry>>,
}

impl ToolRegistry {
    /// 只准备当前将要调度的调用；非法参数作为顺序调用的错误观察返回。
    pub(crate) fn prepare<'a>(&'a self, call: &'a ToolCall) -> PreparedCall<'a> {
        let invocation = match self.entries.get(&call.name) {
            None => Err(ToolError::Execution(format!("未知工具：{}", call.name))),
            Some(entry) => match entry.validator.validate(&call.arguments) {
                Err(error) => Err(ToolError::Execution(format!("参数不符合 Schema：{error}"))),
                Ok(()) => entry.tool.prepare(call.arguments.clone()),
            },
        };
        PreparedCall { call, invocation }
    }

    /// 创建空工具集合。
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个强类型工具；同一份 Schema 用于模型声明和执行前校验。
    ///
    /// # 错误
    /// 名称不合法、名称重复、Schema 无效时拒绝注册，原集合不变。
    pub fn register<T: Tool>(&mut self, tool: T) -> Result<(), Error> {
        let name = tool.name().to_owned();
        if self.entries.contains_key(&name) {
            return Err(Error::Config(format!("工具名称重复：{name}")));
        }
        let schema = serde_json::to_value(schemars::schema_for!(T::Args))
            .map_err(|error| Error::Config(error.to_string()))?;
        let definition = ToolDefinition {
            name: name.clone(),
            description: tool.description().into(),
            input_schema: schema,
        };
        let validator = definition.compile()?;
        self.entries.insert(
            name,
            Arc::new(Entry {
                definition,
                validator,
                tool: Box::new(TypedTool(tool)),
            }),
        );
        Ok(())
    }

    /// 移除一个工具，返回是否存在；已有运行持有的快照不受影响。
    pub fn remove(&mut self, name: &str) -> bool {
        self.entries.remove(name).is_some()
    }

    /// 返回按名称排列的声明快照，使模型输入顺序稳定。
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.entries
            .values()
            .map(|entry| entry.definition.clone())
            .collect()
    }

    /// 在临时会话中执行完整调用；参数和业务错误转成观察，取消及基础设施失败向上传播。
    ///
    /// 临时会话在调用结束时释放；需要保留后台终端时使用 execute_in_session。
    ///
    /// # 错误
    /// 执行被取消、超时，或工具返回基础设施失败时返回对应错误。
    pub async fn execute(
        &self,
        call: &ToolCall,
        context: ExecutionContext,
    ) -> Result<ToolResult, Error> {
        self.execute_in_session(call, context, &AgentSession::new())
            .await
    }

    /// 在给定会话内执行调用；会话关闭会取消等待，跨轮资源由会话统一管理。
    ///
    /// `call` 是模型调用，`context` 约束本次等待，`session` 必须由宿主提供。
    /// 返回模型可见的成功或错误观察；不改变调用方的父取消信号。
    /// # 错误
    /// 会话已关闭、执行被取消或超时、基础设施失败时返回对应错误。
    pub async fn execute_in_session(
        &self,
        call: &ToolCall,
        context: ExecutionContext,
        session: &AgentSession,
    ) -> Result<ToolResult, Error> {
        context.check()?;
        self.prepare(call).execute(context, session).await
    }
}

/// 不可变的已准备调用；序列化边界只经过一次，调度无法替换执行参数。
pub(crate) struct PreparedCall<'a> {
    pub(crate) call: &'a ToolCall,
    invocation: Result<Box<dyn Invocation + 'a>, ToolError>,
}

impl PreparedCall<'_> {
    pub(crate) fn concurrency(&self) -> ToolConcurrency {
        self.invocation
            .as_ref()
            .map_or(ToolConcurrency::Sequential, |invocation| {
                invocation.concurrency()
            })
    }

    pub(crate) async fn execute(
        self,
        context: ExecutionContext,
        session: &AgentSession,
    ) -> Result<ToolResult, Error> {
        let context = ExecutionContext {
            cancellation: context.cancellation.child_token(),
            deadline: context.deadline,
        };
        let _lease = session.register(context.cancellation.clone())?;
        context.check()?;
        let result = match self.invocation {
            Err(error) => Err(error),
            Ok(invocation) => {
                let tool_context = ToolContext {
                    call_id: self.call.id.clone(),
                    execution: context.clone(),
                    session: session.clone(),
                };
                context.wait(invocation.call(tool_context)).await?
            }
        };
        let (output, media, is_error) = match result {
            Ok((output, media)) => (output, media, false),
            Err(ToolError::Execution(message)) => (json!({"error": message}), Vec::new(), true),
            Err(ToolError::Infrastructure(message)) => {
                return Err(Error::ToolInfrastructure(message));
            }
        };
        Ok(ToolResult {
            call_id: self.call.id.clone(),
            name: self.call.name.clone(),
            output,
            is_error,
            media,
        })
    }
}
