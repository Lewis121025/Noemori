use super::{contract::*, state::State};
use crate::{
    ContentPart, Role,
    llm::ModelEvent,
    runtime::{AgentEvent, AgentStream, RunReport, RunStatus},
};
use futures::StreamExt;
use std::sync::Arc;
use tokio::sync::watch;

/// 每轮终态与历史同锁提交；未消费或异常丢弃的运行也解除占用，不自动重放工具。
pub(super) struct Guard {
    pub(super) state: Arc<State>,
    pub(super) id: String,
    pub(super) done: watch::Sender<bool>,
    pub(super) finished: bool,
}
impl Drop for Guard {
    fn drop(&mut self) {
        if !self.finished {
            let mut data = self.state.data.lock().expect("桌面会话锁被污染");
            if data
                .active
                .as_ref()
                .is_some_and(|active| active.id == self.id)
            {
                data.active.take();
                if let Some(run) = &mut data.run {
                    run.status = HostRunStatus::Failed;
                    run.error = Some("运行任务在交付终态前被释放，未确认的工具不得自动重试".into());
                }
            }
            drop(data);
            self.state.notify();
        }
        self.done.send_replace(true);
    }
}
pub(super) async fn drive(mut stream: AgentStream, mut guard: Guard) {
    while let Some(event) = stream.next().await {
        match event {
            AgentEvent::ModelStarted { call } => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                let index = data.messages.len();
                data.messages.push(HostMessage {
                    role: Role::Assistant,
                    content: Vec::new(),
                });
                if let Some(active) = &mut data.active {
                    active.draft = Some(index);
                }
                if let Some(run) = &mut data.run {
                    run.model_calls = call;
                }
                drop(data);
                guard.state.notify();
            }
            AgentEvent::Model(ModelEvent::TextDelta(text)) => guard.state.append_text(text, false),
            AgentEvent::Model(ModelEvent::ReasoningDelta(text)) => {
                guard.state.append_text(text, true)
            }
            AgentEvent::Model(ModelEvent::Finished(response)) => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                if let Some(index) = data.active.as_ref().and_then(|active| active.draft) {
                    data.messages[index].content = response.message.content;
                }
                drop(data);
                guard.state.notify();
            }
            AgentEvent::ToolStarted(call) => {
                guard
                    .state
                    .data
                    .lock()
                    .expect("桌面会话锁被污染")
                    .calls
                    .insert(call.id.clone(), call);
                guard.state.notify();
            }
            AgentEvent::ToolFinished(result) => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                data.calls.remove(&result.call_id);
                data.messages.push(HostMessage {
                    role: Role::Tool,
                    content: vec![ContentPart::ToolResult(result)],
                });
                drop(data);
                guard.state.notify();
            }
            AgentEvent::Finished(report) => {
                finish(&guard.state, *report);
                guard.finished = true;
                return;
            }
            AgentEvent::RetryScheduled { .. }
            | AgentEvent::Model(ModelEvent::ToolCallDelta { .. }) => {}
        }
    }
}
fn finish(state: &State, report: RunReport) {
    let (status, error) = match report.status {
        RunStatus::Completed => (HostRunStatus::Completed, None),
        RunStatus::Cancelled => (HostRunStatus::Cancelled, None),
        RunStatus::TimedOut => (HostRunStatus::TimedOut, None),
        RunStatus::BudgetExhausted => (HostRunStatus::BudgetExhausted, None),
        RunStatus::Truncated => (HostRunStatus::Truncated, None),
        RunStatus::Filtered => (HostRunStatus::Filtered, None),
        RunStatus::Failed(error) => (HostRunStatus::Failed, Some(error.to_string())),
    };
    let mut data = state.data.lock().expect("桌面会话锁被污染");
    data.history = report.history;
    data.pending_note=report.pending_turn.map(|pending|format!("上次运行中断。下列工具可能已产生副作用，不能自动重放；后续应以实际工作区状态为准。已尝试调用：{:?}；已取得结果：{}",pending.attempted_tool_ids,serde_json::to_string(&pending.tool_results).unwrap_or_else(|error|format!("结果编码失败：{error}"))));
    if let Some(run) = &mut data.run {
        run.status = status;
        run.error = error;
        run.model_calls = report.model_calls;
    }
    data.active.take();
    data.calls.clear();
    data.approvals.clear();
    drop(data);
    state.notify();
}
