use super::{PendingTurn, RunReport, RunStatus};
use crate::{
    Error, Message,
    llm::{ModelEvent, ModelResponse, Usage},
    validate_history,
};

#[cfg(test)]
#[path = "../../../../test/agent/runtime/unit/pause.rs"]
mod pause_tests;

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

    /// 仅恢复已完成的模型响应；流式片段必须重新请求，已开始但无结果的工具只能记录未确认。
    pub fn resume(&mut self, pending: Option<PendingTurn>) -> Vec<crate::ToolResult> {
        let Some(mut pending) = pending else {
            return Vec::new();
        };
        if !pending.model_completed {
            return Vec::new();
        }
        let Some(response) = &pending.response else {
            return Vec::new();
        };
        if !matches!(
            response.finish_reason,
            crate::llm::FinishReason::Stop | crate::llm::FinishReason::ToolCalls
        ) {
            return Vec::new();
        }
        pending.deltas.clear();
        let mut unknown = Vec::new();
        for call in response.message.tool_calls() {
            if pending.attempted_tool_ids.contains(&call.id)
                && !pending
                    .tool_results
                    .iter()
                    .any(|result| result.call_id == call.id)
            {
                let result = crate::ToolResult {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    output: serde_json::json!({"outcome":"unknown", "error":"工具调用在中断前已开始，但执行结果未确认。"}),
                    is_error: true,
                    media: Vec::new(),
                };
                pending.tool_results.push(result.clone());
                unknown.push(result);
            }
        }
        self.pending = Some(pending);
        unknown
    }

    pub fn completed_response(&self) -> Result<&ModelResponse, Error> {
        self.pending
            .as_ref()
            .and_then(|pending| pending.response.as_ref())
            .ok_or_else(|| Error::Protocol("缺少完整模型响应".into()))
    }

    /// 接管关闭当前工具组：已尝试且无结果记为未知，未派发动作记为未执行，不重放旧操作。
    pub fn pause_turn(&mut self) -> Vec<crate::ToolResult> {
        let pending = self.pending.take();
        let mut results = self.resume(pending);
        let Some(pending) = &mut self.pending else {
            return results;
        };
        let Some(response) = &pending.response else {
            return results;
        };
        for call in response.message.tool_calls() {
            if pending
                .tool_results
                .iter()
                .any(|result| result.call_id == call.id)
            {
                continue;
            }
            let result = crate::ToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                output: serde_json::json!({"outcome":"not_executed","error":"用户接管，当前动作未派发；交还后必须重新观察页面。"}),
                is_error: true,
                media: Vec::new(),
            };
            pending.tool_results.push(result.clone());
            results.push(result);
        }
        results
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

    pub fn commit(&mut self) -> Result<Vec<Message>, Error> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| Error::Protocol("缺少待提交轮次".into()))?;
        let response = pending
            .response
            .as_ref()
            .ok_or_else(|| Error::Protocol("缺少完整模型响应".into()))?;
        let mut next = self.history.clone();
        let mut committed = vec![response.message.clone()];
        if !pending.tool_results.is_empty() {
            let mut results = pending.tool_results.clone();
            let ids: Vec<_> = response.message.tool_calls().map(|call| &call.id).collect();
            results.sort_by_key(|result| ids.iter().position(|id| **id == result.call_id));
            committed.push(Message::tool_results(results));
        }
        next.extend(committed.iter().cloned());
        validate_history(&next).map_err(|error| Error::Protocol(error.to_string()))?;
        self.history = next;
        self.pending = None;
        Ok(committed)
    }

    pub fn finish(self, status: RunStatus, pending_inputs: Vec<Message>) -> RunReport {
        RunReport {
            status,
            history: self.history,
            pending_turn: self.pending,
            pending_inputs,
            model_calls: self.model_calls,
            usage: self.usage,
        }
    }
}
