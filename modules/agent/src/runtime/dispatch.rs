use super::{AgentEvent, state::RunState};
use crate::{
    AgentSession, Error, ExecutionContext, ToolCall,
    tool::{ToolConcurrency, ToolRegistry},
};
use futures::{Stream, StreamExt, stream::FuturesUnordered};

/// 相邻的并发安全调用全部进入调度，顺序调用是屏障；回填历史按模型顺序，事件按实际完成顺序。
pub(super) fn batch<'a>(
    state: &'a mut RunState,
    tools: &'a ToolRegistry,
    calls: &'a [ToolCall],
    context: ExecutionContext,
    session: &'a AgentSession,
) -> impl Stream<Item = Result<AgentEvent, Error>> + Send + 'a {
    async_stream::try_stream! {
        let mut remaining = calls.iter();
        let mut pending = remaining.next().map(|call| tools.prepare(call));
        while let Some(first) = pending.take() {
            let concurrent = first.concurrency() == ToolConcurrency::Concurrent;
            let mut first = Some(first);
            let base = state.pending_mut()?.tool_results.len();
            let mut completed = Vec::new();
            let mut running = FuturesUnordered::new();
            let mut next = 0;
            loop {
                loop {
                    context.check()?;
                    let invocation = if let Some(first) = first.take() { first }
                        else if concurrent {
                            if pending.is_none() { pending = remaining.next().map(|call| tools.prepare(call)); }
                            if pending.as_ref().is_some_and(|call| call.concurrency() == ToolConcurrency::Concurrent) {
                                pending.take().expect("已确认下一调用存在")
                            } else { break; }
                        } else { break; };
                    let index = next;
                    let call = invocation.call;
                    state.pending_mut()?.attempted_tool_ids.push(call.id.clone());
                    yield AgentEvent::ToolStarted(call.clone());
                    let execution = context.clone();
                    running.push(async move { (index, invocation.execute(execution, session).await) });
                    next += 1;
                }
                let Some((index, result)) = running.next().await else { break; };
                let result = result?;
                let position = completed.partition_point(|previous| *previous < index);
                completed.insert(position, index);
                state.pending_mut()?.tool_results.insert(base + position, result.clone());
                yield AgentEvent::ToolFinished(result);
            }
            if pending.is_none() { pending = remaining.next().map(|call| tools.prepare(call)); }
        }
    }
}
