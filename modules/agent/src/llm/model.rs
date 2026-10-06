use super::{ModelEvent, ModelRequest, ModelResponse};
use crate::{Error, ExecutionContext};
use futures::{Stream, StreamExt};
use std::pin::Pin;

/// 具体模型声明的能力；工具能力必须由配置方明确开启。
#[derive(Clone, Copy, Debug, Default)]
pub struct Capabilities {
    /// 是否允许发送工具声明；不支持时必须在请求前拒绝。
    pub tools: bool,
    /// HTTP 适配器是否请求原生流；关闭后以一个完成事件返回整个响应。
    pub streaming: bool,
    /// 是否允许图像输入；必须由调用方明确声明，不能根据模型名猜测。
    pub vision: bool,
    /// 是否允许音频输入；协议自身的格式和来源限制仍由适配器校验。
    pub audio: bool,
    /// 是否允许视频输入；不能由视觉图片能力推断。
    pub video: bool,
}

/// 按消费推进的模型事件流；成功时恰好包含一个末尾的完成事件。
pub type ModelStream = Pin<Box<dyn Stream<Item = Result<ModelEvent, Error>> + Send>>;

/// 自定义模型边界；实现可连接服务商，也可以返回可控的测试事件。
pub trait Model: Send + Sync + 'static {
    /// 返回具体模型能力，不根据模型名称猜测。
    fn capabilities(&self) -> Capabilities;

    /// 生成标准化事件；响应结束前的工具参数不能被执行。
    ///
    /// # 错误
    /// 配置、传输和协议失败通过事件流返回；取消必须释放持有的请求。
    /// 实现不得启动脱离返回流生命周期的后台任务，成功流必须以唯一完成事件结束。
    fn generate(&self, request: ModelRequest, context: ExecutionContext) -> ModelStream;
}

/// 消费与流式调用相同的模型路径并返回完整响应。
///
/// `request` 指定完整历史及工具声明，`context` 控制取消和截止时间。
/// 返回的 `finish_reason` 仍可能表示截断或过滤，调用方应据此决定是否继续。
///
/// # 错误
/// 输入无效、请求失败、缺少完成事件或完成后仍有事件时返回错误。
pub async fn generate(
    model: &dyn Model,
    request: ModelRequest,
    context: ExecutionContext,
) -> Result<ModelResponse, Error> {
    let mut stream = Box::pin(checked_stream(model, request, context));
    let mut response = None;
    while let Some(event) = stream.next().await {
        if let ModelEvent::Finished(value) = event? {
            response = Some(*value);
        }
    }
    response.ok_or_else(|| Error::Protocol("模型流缺少完成事件".into()))
}

/// 独立生成和 Agent 共用流生命周期，防止某个入口绕过取消或终止校验。
pub(crate) fn checked_stream(
    model: &dyn Model,
    request: ModelRequest,
    context: ExecutionContext,
) -> impl Stream<Item = Result<ModelEvent, Error>> + Send + '_ {
    async_stream::try_stream! {
        context.check()?;
        request.validate(model.capabilities())?;
        let previous_calls: std::collections::BTreeSet<_> = request.messages.iter()
            .flat_map(crate::Message::tool_calls).map(|call| call.id.clone()).collect();
        let mut stream = model.generate(request, context.clone());
        let mut completed = false;
        while let Some(event) = context.wait(stream.next()).await? {
            if completed { Err(Error::Protocol("模型完成后仍返回事件".into()))?; }
            let event = event?;
            if let ModelEvent::Finished(response) = &event {
                response.validate()?;
                if response.message.tool_calls().any(|call| previous_calls.contains(&call.id)) {
                    Err(Error::Protocol("模型重复使用历史工具调用 ID".into()))?;
                }
                completed = true;
            }
            yield event;
        }
        if !completed { Err(Error::Protocol("模型流缺少完成事件".into()))?; }
    }
}
