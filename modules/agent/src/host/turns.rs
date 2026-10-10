use super::{HostRunView, state::Data};
use serde::{Deserialize, Serialize};

/// 一次运行尝试及其响应范围；恢复尝试关联前次运行，消息范围采用左闭右开区间。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostTurn {
    /// 运行身份与终态；轮次与模型内部多次调用不混为一谈。
    pub run: HostRunView,
    /// 本次尝试的消息起点；恢复尝试不会新增用户消息。
    pub message_start: usize,
    /// 本轮结束后的消息位置；运行中快照会随流式输出增长。
    pub message_end: usize,
    /// 指向本轮接续的上一运行；恢复尝试不伪造新的用户输入，允许空消息范围。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_from: Option<String>,
}

/// 持久化历史偏移与未提交节点，避免每轮复制整段已提交历史产生平方级存储。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TurnCheckpoint {
    pub(super) view: HostTurn,
    pub(super) history_start: usize,
    pub(super) history_end: usize,
    pub(super) pending_note_before: Option<String>,
    pub(super) pending_note_after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending_turn_after: Option<crate::runtime::PendingTurn>,
    /// 此轮结束时仍未交给模型的用户输入，索引指向私有原始消息。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) pending_inputs_after: Vec<usize>,
}

/// 轮次复用同锁计算的可见运行状态，暂停投影不能与快照顶层分叉。
/// data 保留私有历史边界，run 是已投影的当前运行；返回独立数组，不修改或抛出错误。
pub(super) fn visible_turns(data: &Data, run: Option<&HostRunView>) -> Vec<HostTurn> {
    data.turns
        .iter()
        .map(|turn| {
            let mut view = turn.view.clone();
            if let Some(run) = run
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
        turn.pending_turn_after = data.pending_turn.clone();
        turn.pending_inputs_after = data.pending_inputs.clone();
    }
}
