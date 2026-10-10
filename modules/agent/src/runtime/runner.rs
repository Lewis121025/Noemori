use super::{Agent, AgentEvent, AgentStream, RunInput, RunStatus, dispatch, state::RunState};
use crate::{
    Error, ExecutionContext,
    llm::{FinishReason, Model, ModelEvent, ModelRequest, checked_stream},
};
use futures::{Stream, StreamExt};
use std::sync::Arc;

#[cfg(test)]
#[path = "../../../../test/agent/runtime/unit/resume.rs"]
mod resume_tests;

pub(super) fn drive(
    agent: Agent,
    input: RunInput,
    mut context: ExecutionContext,
    lease: crate::session::RunLease,
    control: Option<super::RunControl>,
    pending: Option<super::PendingTurn>,
) -> AgentStream {
    Box::pin(async_stream::stream! {
        // 流被丢弃时取消子任务；调用方的父信号不受影响。
        let _lease = lease;
        let mut state = RunState::new(input.messages);
        for result in state.resume(pending) { yield AgentEvent::ToolFinished(result); }
        let mut retries = 0;
        let mut retry_at = None;
        let status = 'running: loop {
            if let Some(control) = &control
                && control.pause_requested() {
                    control.mark_paused();
                    yield AgentEvent::Paused;
                    if let Err(error) = control.wait_resume(&mut context).await { break RunStatus::from_error(error); }
                    yield AgentEvent::Resumed;
            }
            if let Err(error) = context.check() { break RunStatus::from_error(error); }
            let mut execution = context.clone();
            if let Some(control) = &control { execution.cancellation = control.execution(&context.cancellation); }
            if let Some(at) = retry_at {
                if let Err(error) = execution.wait(tokio::time::sleep_until(at)).await {
                    if interrupted_for_takeover(&error, control.as_ref(), &context) { continue; }
                    break RunStatus::from_error(error);
                }
                retry_at = None;
            }
            if state.pending.is_none() {
            if state.model_calls >= agent.options.max_model_calls { break RunStatus::BudgetExhausted; }
            if let Some(control) = &control {
                let inputs = control.drain();
                if !inputs.is_empty() {
                    state.history.extend(inputs.iter().cloned());
                    yield AgentEvent::InputsCommitted(inputs);
                }
            }
            state.begin_model();
            yield AgentEvent::ModelStarted { call: state.model_calls };
            let request = ModelRequest {
                messages: super::browser_history::for_model(&state.history, agent.model.capabilities().vision), tools: agent.tools.definitions(), options: input.generation.clone(),
            };
            let mut stream = Box::pin(model_turn(&mut state, agent.model.clone(), request, execution.clone()));
            let mut failure = None;
            let mut emitted = false;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => { emitted = true; yield AgentEvent::Model(event); }
                    Err(error) => { failure = Some(error); break; }
                }
            }
            drop(stream);
            if let Some(error) = failure {
                if interrupted_for_takeover(&error, control.as_ref(), &context) {
                    state.pending = None;
                    continue;
                }
                if emitted || !error.is_retryable() || retries >= agent.options.max_retries
                    || state.model_calls >= agent.options.max_model_calls
                { break RunStatus::from_error(error); }
                retries += 1;
                let delay = retry_delay(&error, &agent, &context);
                // 服务商的等待时间按真实时钟保留；接管中断等待，交还后仍遵守原重试时间。
                retry_at = Some(tokio::time::Instant::now() + delay);
                yield AgentEvent::RetryScheduled { after: delay };
                state.pending = None;
                continue;
            }
            }
            retries = 0;
            if let Some(pending) = &mut state.pending { pending.model_completed = true; }
            yield AgentEvent::ModelCompleted;
            let response = match state.completed_response() {
                Ok(response) => response,
                Err(error) => break RunStatus::from_error(error),
            };
            if let Some(status) = termination(&response.finish_reason) { break status; }
            let has_calls = response.message.tool_calls().next().is_some();
            let attempted = &state.pending.as_ref().expect("已确认完整响应").attempted_tool_ids;
            let calls: Vec<_> = response.message.tool_calls().filter(|call| !attempted.contains(&call.id)).cloned().collect();
            let mut tools = Box::pin(dispatch::batch(&mut state, &agent.tools, &calls, execution, &input.session));
            let mut paused = false;
            while let Some(event) = tools.next().await {
                match event {
                    Ok(event) => yield event,
                    Err(error) if interrupted_for_takeover(&error, control.as_ref(), &context) => { paused = true; break; }
                    Err(error) => { drop(tools); break 'running RunStatus::from_error(error); }
                }
            }
            drop(tools);
            if paused { for result in state.pause_turn() { yield AgentEvent::ToolFinished(result); } }
            if let Err(error) = context.check() { break RunStatus::from_error(error); }
            let from = state.history.len();
            let messages = match state.commit() { Ok(messages) => messages, Err(error) => break RunStatus::from_error(error) };
            yield AgentEvent::HistoryCommitted { from, messages };
            if let Some(control) = &control
                && calls.iter().any(|call| matches!(call.name.as_str(), "browser" | "ui_repl")) && (input.session.browser_snapshot().status == crate::tool::browser::BrowserStatus::Human || input.session.ui_snapshot().connections.iter().any(|connection| connection.connected && connection.human)) {
                control.pause();
            }
            if !has_calls && control.as_ref().is_none_or(super::RunControl::complete_if_empty) { break RunStatus::Completed; }
        };
        let pending_inputs = control.as_ref().map(super::RunControl::finish).unwrap_or_default();
        yield AgentEvent::Finished(Box::new(state.finish(status, pending_inputs)));
    })
}

/// 接管只取消当前节点；整轮显式取消不能被误解释为可恢复暂停。
fn interrupted_for_takeover(
    error: &Error,
    control: Option<&super::RunControl>,
    context: &ExecutionContext,
) -> bool {
    matches!(error, Error::Cancelled)
        && control.is_some_and(super::RunControl::pause_requested)
        && !context.cancellation.is_cancelled()
}

fn model_turn(
    state: &mut RunState,
    model: Arc<dyn Model>,
    request: ModelRequest,
    context: ExecutionContext,
) -> impl Stream<Item = Result<ModelEvent, Error>> + Send + '_ {
    async_stream::try_stream! {
        let mut stream = Box::pin(checked_stream(model.as_ref(), request, context));
        while let Some(event) = stream.next().await {
            let event = event?;
            match &event {
                ModelEvent::Finished(response) => state.response((**response).clone())?,
                delta => state.delta(delta.clone())?,
            }
            yield event;
        }
    }
}

fn retry_delay(error: &Error, agent: &Agent, context: &ExecutionContext) -> std::time::Duration {
    let delay = match error {
        Error::Http {
            retry_after: Some(delay),
            ..
        } => *delay,
        _ => agent.options.retry_delay,
    };
    delay.min(
        context
            .deadline
            .saturating_duration_since(tokio::time::Instant::now()),
    )
}

fn termination(reason: &FinishReason) -> Option<RunStatus> {
    match reason {
        FinishReason::Length => Some(RunStatus::Truncated),
        FinishReason::ContentFilter => Some(RunStatus::Filtered),
        FinishReason::Other(reason) => Some(RunStatus::Failed(Error::Protocol(format!(
            "模型未正常结束：{reason}"
        )))),
        FinishReason::Stop | FinishReason::ToolCalls => None,
    }
}
