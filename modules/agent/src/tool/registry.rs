use super::{Tool, ToolContext, ToolDefinition, ToolError};
use crate::{AgentSession, Error, ExecutionContext, Media, ToolCall, ToolResult};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

/// 在异构注册表内统一调用入口，具体参数和返回值仍由各工具的类型契约约束。
#[async_trait]
trait ErasedTool: Send + Sync {
    async fn call(
        &self,
        args: Value,
        context: ToolContext,
    ) -> Result<(Value, Vec<Media>), ToolError>;
}

/// 在 JSON 边界完成序列化转换，使工具实现保留强类型参数和返回值。
struct TypedTool<T>(T);

#[async_trait]
impl<T: Tool> ErasedTool for TypedTool<T> {
    async fn call(
        &self,
        args: Value,
        context: ToolContext,
    ) -> Result<(Value, Vec<Media>), ToolError> {
        let args = serde_json::from_value(args)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let output = self.0.execute(args, context).await?;
        let media = self.0.media(&output);
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
        let context = ExecutionContext {
            cancellation: context.cancellation.child_token(),
            deadline: context.deadline,
        };
        let _lease = session.register(context.cancellation.clone())?;
        context.check()?;
        let result = match self.entries.get(&call.name) {
            None => Err(ToolError::Execution(format!("未知工具：{}", call.name))),
            Some(entry) => {
                if let Err(error) = entry.validator.validate(&call.arguments) {
                    Err(ToolError::Execution(format!("参数不符合 Schema：{error}")))
                } else {
                    let tool_context = ToolContext {
                        call_id: call.id.clone(),
                        execution: context.clone(),
                        session: session.clone(),
                    };
                    context
                        .wait(entry.tool.call(call.arguments.clone(), tool_context))
                        .await?
                }
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
            call_id: call.id.clone(),
            name: call.name.clone(),
            output,
            is_error,
            media,
        })
    }
}
