use super::{
    DesktopSession, HostMessage, HostRunStatus, HostRunView, HostSnapshot, turns::TurnCheckpoint,
};
use crate::{ContentPart, Error, Message, Role, validate_history};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::PathBuf};

/// 仅供可信宿主持久化的闭合历史；供应商签名留在宿主，不交付渲染窗口。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostCheckpoint {
    version: u32,
    workspace: PathBuf,
    history: Vec<Message>,
    /// 缺少归属的旧记录在首次选择模型时显式转为通用历史。
    #[serde(default)]
    model_binding: Option<String>,
    messages: Vec<HostMessage>,
    run: Option<HostRunView>,
    pending_note: Option<String>,
    /// 旧版记录缺少精确轮次边界，保留整体历史；不根据展示文本猜测供应商上下文。
    #[serde(default)]
    turns: Vec<TurnCheckpoint>,
}

impl HostCheckpoint {
    /// 将随笔记库迁移的静态历史绑定到用户重新打开的库根；不恢复旧运行资源。
    /// 目录必须真实存在，检查点必须合法；解析或目录校验失败时返回错误。
    pub fn relocate(mut self, workspace: &std::path::Path) -> Result<Self, Error> {
        self.validate()?;
        let root = workspace
            .canonicalize()
            .map_err(|error| Error::Config(format!("库目录不可访问：{error}")))?;
        if !root.is_dir() {
            return Err(Error::Config("库根不是目录".into()));
        }
        self.workspace = root;
        Ok(self)
    }
    fn validate(&self) -> Result<(), Error> {
        if !matches!(self.version, 1 | 2) {
            return Err(Error::Config("对话记录版本不支持".into()));
        }
        if !self
            .history
            .first()
            .is_some_and(|message| message.role == Role::System)
        {
            return Err(Error::Protocol("对话记录缺少宿主系统指令".into()));
        }
        // 尚未发送的对话是合法持久化状态，但不是合法模型请求；其余历史仍遵循闭合校验。
        if self.history.len() == 1 {
            let system = &self.history[0];
            if !matches!(system.content.as_slice(), [ContentPart::Text(_)])
                || system.provider_data.is_some()
                || !self.messages.is_empty()
                || !self.turns.is_empty()
                || self.run.is_some()
                || self.pending_note.is_some()
            {
                return Err(Error::Protocol("未开始的对话不能包含运行或消息记录".into()));
            }
            return Ok(());
        }
        validate_history(&self.history).map_err(|error| Error::Protocol(error.to_string()))?;
        let mut prior: Option<&TurnCheckpoint> = None;
        let mut ids = BTreeSet::new();
        for turn in &self.turns {
            let view = &turn.view;
            if !ids.insert(&view.run.id)
                || view.run.status == HostRunStatus::Running
                || turn.history_start >= turn.history_end
                || turn.history_end > self.history.len()
                || view.message_start >= view.message_end
                || view.message_end > self.messages.len()
                || self.history[turn.history_start].role != Role::User
                || self.messages[view.message_start].role != Role::User
                || prior.is_some_and(|previous| {
                    previous.history_end != turn.history_start
                        || previous.view.message_end != view.message_start
                })
            {
                return Err(Error::Protocol("对话轮次边界无效".into()));
            }
            prior = Some(turn);
        }
        if let Some(last) = prior
            && (last.history_end != self.history.len()
                || last.view.message_end != self.messages.len()
                || self
                    .run
                    .as_ref()
                    .is_none_or(|run| run.id != last.view.run.id))
        {
            return Err(Error::Protocol("对话末轮与历史不一致".into()));
        }
        Ok(())
    }

    /// 从指定已结算轮次之后分叉，复制上下文而不创建或继承运行资源。
    /// # 参数
    /// turn_id 为可见轮次身份；None 表示完整检查点（包括明确记录的中断事实）。
    /// # 返回
    /// 独立历史检查点，保留供应商私有载荷和必要的中断说明，原记录保持不变。
    /// # 错误
    /// 历史不闭合、轮次未知或边界损坏时拒绝，不截取未经验证的消息片段。
    pub fn branch_after(&self, turn_id: Option<&str>) -> Result<Self, Error> {
        self.validate()?;
        let mut branch = self.clone();
        branch.version = 2;
        if let Some(id) = turn_id {
            let index = self
                .turns
                .iter()
                .position(|turn| turn.view.run.id == id)
                .ok_or_else(|| Error::Config("分叉轮次不存在或来自早期无边界记录".into()))?;
            let turn = &self.turns[index];
            branch.history.truncate(turn.history_end);
            branch.messages.truncate(turn.view.message_end);
            branch.turns.truncate(index + 1);
            branch.run = Some(turn.view.run.clone());
            branch.pending_note = turn.pending_note_after.clone();
        }
        branch.validate()?;
        Ok(branch)
    }

    /// 把可信检查点投影为只读界面状态，不启动模型、浏览器或终端。
    /// # 返回
    /// 标识由持久化服务赋值；所有资源列表为空，供应商私有载荷不会进入投影。
    /// # 错误
    /// 检查点版本、历史或边界非法时拒绝。
    pub fn snapshot(&self) -> Result<HostSnapshot, Error> {
        self.validate()?;
        Ok(HostSnapshot {
            ui: Default::default(),
            id: String::new(),
            workspace: self.workspace.to_string_lossy().into_owned(),
            revision: 0,
            closed: false,
            run: self.run.clone(),
            turns: self.turns.iter().map(|turn| turn.view.clone()).collect(),
            messages: super::state::visible_messages(&self.messages),
            terminals: Vec::new(),
            approvals: Vec::new(),
            browser: Default::default(),
        })
    }
}

impl DesktopSession {
    /// 在同一把状态锁内生成可恢复记录，运行中的工具只保留已观察事实。
    /// # 返回
    /// 不包含进程句柄、活动审批或模型认证的记录；新宿主必须重新建立资源。
    /// # 错误
    /// 历史或轮次边界损坏时拒绝，不生成会自动重放工具的记录。
    pub fn checkpoint(&self) -> Result<HostCheckpoint, Error> {
        let state = &self.0.0.state;
        let data = state.data.lock().expect("桌面会话锁被污染");
        let mut run = data.run.clone();
        let mut pending_note = data.pending_note.clone();
        if data.active.is_some() {
            // 同一轮可以接受多次用户补充，观察事实必须从整轮起点保留。
            let from = data.turns.last().map_or(0, |turn| turn.view.message_start);
            pending_note = Some(super::progress::observed_note(
                &data.messages[from..],
                &data.calls.keys().cloned().collect::<Vec<_>>(),
            ));
            if let Some(run) = &mut run {
                run.status = HostRunStatus::Cancelled;
                run.error = Some("此轮记录来自中断现场，继续前会先核实实际状态。".into());
            }
        }
        let mut turns = data.turns.clone();
        if let Some(turn) = turns.last_mut()
            && let Some(run) = &run
        {
            turn.view.run = run.clone();
            turn.view.message_end = data.messages.len();
            turn.history_end = data.history.len();
            turn.pending_note_after = pending_note.clone();
        }
        let checkpoint = HostCheckpoint {
            version: 2,
            workspace: state.workspace.clone(),
            history: data.history.clone(),
            model_binding: data.model_binding.clone(),
            messages: data.messages.clone(),
            run,
            pending_note,
            turns,
        };
        checkpoint.validate()?;
        Ok(checkpoint)
    }

    /// 把持久化历史接到尚未使用的新宿主，不启动模型或恢复旧进程与审批。
    /// # 参数
    /// checkpoint 必须来自同一工作目录，历史必须满足完整工具调用与结果配对契约。
    /// # 错误
    /// 版本未知、目录不符、历史非法或当前宿主已使用时拒绝，保持当前状态不变。
    pub fn restore(&self, checkpoint: HostCheckpoint) -> Result<(), Error> {
        let state = &self.0.0.state;
        state.ensure_open()?;
        checkpoint.validate()?;
        if checkpoint.workspace != state.workspace {
            return Err(Error::Config("对话记录工作目录不匹配".into()));
        }
        let mut data = state.data.lock().expect("桌面会话锁被污染");
        if data.active.is_some()
            || data.run.is_some()
            || !data.messages.is_empty()
            || !data.terminals.is_empty()
            || !data.calls.is_empty()
        {
            return Err(Error::Config("只能向未使用的会话恢复记录".into()));
        }
        data.history = checkpoint.history;
        data.model_binding = checkpoint.model_binding;
        data.messages = checkpoint.messages;
        data.run = checkpoint.run;
        data.pending_note = checkpoint.pending_note;
        data.turns = checkpoint.turns;
        drop(data);
        state.notify();
        Ok(())
    }
}
