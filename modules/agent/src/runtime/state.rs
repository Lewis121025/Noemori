use super::{PendingTurn, RunReport, RunStatus};
use crate::{
    Error, Message,
    llm::{ModelEvent, ModelResponse, Usage},
    validate_history,
};

/// 分开持有已提交历史与当前轮次，仅在响应及工具结果闭合后提交，避免失败污染下一次输入。
pub(super) struct RunState {
    pub history: Vec<Message>,
    pub pending: Option<PendingTurn>,
    pub model_calls: usize,
    pub usage: Vec<Usage>,
}

impl RunState {
    pub fn new(history: Vec<Message>) -> Self {
        Self {
            history,
            pending: None,
            model_calls: 0,
            usage: Vec::new(),
        }
    }

    pub fn begin_model(&mut self) {
        self.model_calls += 1;
        self.pending = Some(PendingTurn::default());
    }

    pub fn pending_mut(&mut self) -> Result<&mut PendingTurn, Error> {
        self.pending
            .as_mut()
            .ok_or_else(|| Error::Protocol("缺少正在执行的轮次".into()))
    }

    pub fn completed_response(&self) -> Result<&ModelResponse, Error> {
        self.pending
            .as_ref()
            .and_then(|pending| pending.response.as_ref())
            .ok_or_else(|| Error::Protocol("缺少完整模型响应".into()))
    }

    pub fn delta(&mut self, delta: ModelEvent) -> Result<(), Error> {
        self.pending_mut()?.deltas.push(delta);
        Ok(())
    }

    pub fn response(&mut self, response: ModelResponse) -> Result<(), Error> {
        response.validate()?;
        self.usage.push(response.usage.clone());
        let pending = self.pending_mut()?;
        if matches!(
            response.finish_reason,
            crate::llm::FinishReason::Stop | crate::llm::FinishReason::ToolCalls
        ) {
            pending.deltas.clear();
        }
        pending.response = Some(response);
        Ok(())
    }

    pub fn commit(&mut self) -> Result<(), Error> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| Error::Protocol("缺少待提交轮次".into()))?;
        let response = pending
            .response
            .as_ref()
            .ok_or_else(|| Error::Protocol("缺少完整模型响应".into()))?;
        let mut next = self.history.clone();
        next.push(response.message.clone());
        if !pending.tool_results.is_empty() {
            next.push(Message::tool_results(pending.tool_results.clone()));
        }
        validate_history(&next).map_err(|error| Error::Protocol(error.to_string()))?;
        self.history = next;
        self.pending = None;
        Ok(())
    }

    pub fn finish(self, status: RunStatus) -> RunReport {
        RunReport {
            status,
            history: self.history,
            pending_turn: self.pending,
            model_calls: self.model_calls,
            usage: self.usage,
        }
    }
}
