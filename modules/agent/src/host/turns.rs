use super::{HostRunView, state::Data};
use serde::{Deserialize, Serialize};

/// 一次用户输入及其后续模型与工具响应构成一轮；消息范围采用左闭右开区间。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostTurn {
    /// 运行身份与终态；轮次与模型内部多次调用不混为一谈。
    pub run: HostRunView,
    /// 本轮用户消息在可见历史中的位置。
    pub message_start: usize,
    /// 本轮结束后的消息位置；运行中快照会随流式输出增长。
    pub message_end: usize,
}

/// 只持久化历史偏移与中断说明，避免每轮复制整段历史产生平方级存储。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TurnCheckpoint {
    pub(super) view: HostTurn,
    pub(super) history_start: usize,
    pub(super) history_end: usize,
    pub(super) pending_note_before: Option<String>,
    pub(super) pending_note_after: Option<String>,
}

/// 运行中的轮次以同锁读取的消息和运行状态为准，不修改已持久化的历史边界。
pub(super) fn visible_turns(data: &Data) -> Vec<HostTurn> {
    data.turns
        .iter()
        .map(|turn| {
            let mut view = turn.view.clone();
            if let Some(run) = &data.run
                && run.id == view.run.id
            {
                view.run = run.clone();
                view.message_end = data.messages.len();
            }
            view
        })
        .collect()
}

/// 历史、消息与终态在同一状态锁下结算，后续分叉仅使用闭合边界。
pub(super) fn settle(data: &mut Data) {
    if let Some(turn) = data.turns.last_mut()
        && let Some(run) = &data.run
        && turn.view.run.id == run.id
    {
        turn.view.run = run.clone();
        turn.view.message_end = data.messages.len();
        turn.history_end = data.history.len();
        turn.pending_note_after = data.pending_note.clone();
    }
}
