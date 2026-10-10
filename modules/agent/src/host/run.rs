use super::{
    contract::*,
    state::{self, State},
};
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
impl Guard {
    /// 内部事件契约损坏时保留恢复现场并解除占用，不能在持锁断言中污染整个会话。
    fn fail(&mut self, error: String) {
        let mut data = self.state.data.lock().expect("桌面会话锁被污染");
        if data
            .active
            .as_ref()
            .is_some_and(|active| active.id == self.id)
        {
            data.pending_note = super::progress::active_note(&data);
            if let Some(active) = data.active.take() {
                active.control.finish();
            }
            data.calls.clear();
            data.approvals.clear();
            if let Some(run) = &mut data.run {
                run.status = HostRunStatus::Failed;
                run.error = Some(error);
            }
        }
        super::turns::settle(&mut data);
        drop(data);
        self.finished = true;
        self.state.notify();
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if !self.finished {
            self.fail("运行任务在交付终态前被释放，未确认的工具不得自动重试".into());
        }
        self.done.send_replace(true);
    }
}
pub(super) async fn drive(mut stream: AgentStream, mut guard: Guard) {
    while let Some(event) = stream.next().await {
        match event {
            AgentEvent::Paused | AgentEvent::Resumed => guard.state.notify(),
            AgentEvent::ModelStarted { call } => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                data.pending_turn = Some(Default::default());
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
                data.pending_turn = Some(crate::runtime::PendingTurn {
                    response: Some((*response).clone()),
                    ..Default::default()
                });
                if let Some(index) = data.active.as_ref().and_then(|active| active.draft) {
                    data.messages[index].content = response.message.content;
                }
                drop(data);
                guard.state.notify();
            }
            AgentEvent::ToolStarted(call) => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                if let Some(pending) = &mut data.pending_turn {
                    pending.attempted_tool_ids.push(call.id.clone());
                }
                data.calls.insert(call.id.clone(), call);
                drop(data);
                guard.state.notify();
            }
            AgentEvent::ToolFinished(result) => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                if let Some(pending) = &mut data.pending_turn
                    && !pending
                        .tool_results
                        .iter()
                        .any(|known| known.call_id == result.call_id)
                {
                    pending.tool_results.push(result.clone());
                }
                data.calls.remove(&result.call_id);
                data.messages.push(HostMessage {
                    role: Role::Tool,
                    content: vec![ContentPart::ToolResult(result)],
                });
                drop(data);
                guard.state.notify();
            }
            AgentEvent::Finished(report) => {
                match finish(&guard.state, *report) {
                    Ok(()) => guard.finished = true,
                    Err(error) => guard.fail(error.to_string()),
                }
                return;
            }
            AgentEvent::HistoryCommitted { from, messages } => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                if from != data.history.len() {
                    drop(data);
                    guard.fail("运行提交历史偏移不一致".into());
                    return;
                }
                data.history.extend(messages);
                data.pending_turn = None;
            }
            AgentEvent::InputsCommitted(messages) => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                let count = messages.len();
                let matches = data.pending_inputs.get(..count).is_some_and(|indices| {
                    state::pending_inputs(&data.messages, indices)
                        .is_ok_and(|known| known == messages)
                });
                if !matches {
                    drop(data);
                    guard.fail("运行提交输入与接收队列不一致".into());
                    return;
                }
                data.history.extend(messages);
                data.pending_inputs.drain(..count);
            }
            AgentEvent::ModelCompleted => {
                let mut data = guard.state.data.lock().expect("桌面会话锁被污染");
                if let Some(pending) = &mut data.pending_turn {
                    pending.model_completed = true;
                }
            }
            AgentEvent::RetryScheduled { .. }
            | AgentEvent::Model(ModelEvent::ToolCallDelta { .. }) => {}
        }
    }
}
fn finish(state: &State, report: RunReport) -> Result<(), crate::Error> {
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
    if state::pending_inputs(&data.messages, &data.pending_inputs)? != report.pending_inputs
        || data.history != report.history
    {
        return Err(crate::Error::Protocol(
            "运行终态与已提交历史或待处理输入不一致".into(),
        ));
    }
    data.pending_note = report
        .pending_turn
        .as_ref()
        .map(|pending| super::progress::pending_note(pending.clone()));
    data.pending_turn = report.pending_turn;
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
    Ok(())
}
