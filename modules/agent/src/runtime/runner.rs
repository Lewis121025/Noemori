use super::{Agent, AgentEvent, AgentStream, RunInput, RunStatus, dispatch, state::RunState};
use crate::{
    Error, ExecutionContext,
    llm::{FinishReason, Model, ModelEvent, ModelRequest, checked_stream},
};
use futures::{Stream, StreamExt};
use std::sync::Arc;

pub(super) fn drive(
    agent: Agent,
    input: RunInput,
    context: ExecutionContext,
    lease: crate::session::RunLease,
) -> AgentStream {
    Box::pin(async_stream::stream! {
        // 流被丢弃时取消子任务；调用方的父信号不受影响。
        let _lease = lease;
        let mut state = RunState::new(input.messages);
        let mut retries = 0;
        let status = 'running: loop {
            if let Err(error) = context.check() { break RunStatus::from_error(error); }
            if state.model_calls >= agent.options.max_model_calls { break RunStatus::BudgetExhausted; }
            state.begin_model();
            yield AgentEvent::ModelStarted { call: state.model_calls };
            let request = ModelRequest {
                messages: super::browser_history::for_model(&state.history), tools: agent.tools.definitions(), options: input.generation.clone(),
            };
            let mut stream = Box::pin(model_turn(&mut state, agent.model.clone(), request, context.clone()));
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
                if emitted || !error.is_retryable() || retries >= agent.options.max_retries
                    || state.model_calls >= agent.options.max_model_calls
                { break RunStatus::from_error(error); }
                retries += 1;
                let delay = retry_delay(&error, &agent, &context);
                yield AgentEvent::RetryScheduled { after: delay };
                if let Err(error) = context.wait(tokio::time::sleep(delay)).await {
                    break RunStatus::from_error(error);
                }
                continue;
            }
            retries = 0;
            let response = match state.completed_response() {
                Ok(response) => response,
                Err(error) => break RunStatus::from_error(error),
            };
            if let Some(status) = termination(&response.finish_reason) { break status; }
            let calls: Vec<_> = response.message.tool_calls().cloned().collect();
            let mut tools = Box::pin(dispatch::batch(&mut state, &agent.tools, &calls, context.clone(), &input.session, agent.options.max_parallel_tools));
            while let Some(event) = tools.next().await {
                match event {
                    Ok(event) => yield event,
                    Err(error) => { drop(tools); break 'running RunStatus::from_error(error); }
                }
            }
            drop(tools);
            if let Err(error) = context.check() { break RunStatus::from_error(error); }
            if let Err(error) = state.commit() { break RunStatus::from_error(error); }
            if calls.is_empty() { break RunStatus::Completed; }
        };
        yield AgentEvent::Finished(Box::new(state.finish(status)));
    })
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
