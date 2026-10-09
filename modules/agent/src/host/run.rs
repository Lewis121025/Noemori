use super::{contract::*, state::State};
use crate::{
    ContentPart, Role,
    llm::ModelEvent,
    runtime::{AgentEvent, AgentStream, RunReport, RunStatus},
};
use futures::StreamExt;
use std::sync::Arc;
use tokio::sync::watch;

/// 更换连接后保留通用事实与工具关联，专有推理降为明确标注的文本，不复用旧签名。
pub(super) fn portable_history(history: &mut [crate::Message]) {
    for message in history {
        message.provider_data = None;
        for part in &mut message.content {
            if let ContentPart::Reasoning(text) = part {
                *part = ContentPart::Text(format!("此前模型的推理记录（非最终回答）：{text}"));
            }
        }
        // 加密推理可能没有通用正文；保留消息占位，避免破坏已保存的轮次索引。
        if message.content.is_empty() {
            message.content.push(ContentPart::Text(
                "此前模型返回了不可迁移的私有推理数据。".into(),
            ));
        }
    }
}

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
                let from = data.turns.last().map_or(0, |turn| turn.view.message_start);
                data.pending_note = Some(super::progress::observed_note(
                    &data.messages[from..],
                    &data.calls.keys().cloned().collect::<Vec<_>>(),
                ));
                if let Some(active) = data.active.take() {
                    data.history.extend(active.control.finish());
                }
                data.calls.clear();
                data.approvals.clear();
                if let Some(run) = &mut data.run {
                    run.status = HostRunStatus::Failed;
                    run.error = Some("运行任务在交付终态前被释放，未确认的工具不得自动重试".into());
                }
            }
            super::turns::settle(&mut data);
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
    data.pending_note = report.pending_turn.map(super::progress::pending_note);
    if let Some(run) = &mut data.run {
        run.status = status;
        run.error = error;
        run.model_calls = report.model_calls;
    }
    data.active.take();
    data.calls.clear();
    data.approvals.clear();
    super::turns::settle(&mut data);
    drop(data);
    state.notify();
}
