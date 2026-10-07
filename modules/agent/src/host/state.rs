use super::contract::*;
use crate::{
    CancellationToken, ContentPart, Error, Message, Role, ToolCall,
    tool::terminal::{TerminalInfo, TerminalSubscription},
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{oneshot, watch};

pub(super) struct Active {
    pub(super) id: String,
    pub(super) cancellation: CancellationToken,
    pub(super) done: watch::Receiver<bool>,
    pub(super) draft: Option<usize>,
}
pub(super) struct TerminalEntry {
    pub(super) view: HostTerminal,
    pub(super) retention: Option<TerminalSubscription>,
}
pub(super) struct Pending {
    pub(super) view: HostApproval,
    pub(super) sender: oneshot::Sender<HostApprovalReply>,
}
pub(super) struct Data {
    pub(super) history: Vec<Message>,
    pub(super) messages: Vec<HostMessage>,
    pub(super) run: Option<HostRunView>,
    pub(super) active: Option<Active>,
    pub(super) pending_note: Option<String>,
    pub(super) approvals: BTreeMap<String, Pending>,
    pub(super) terminals: BTreeMap<String, TerminalEntry>,
    pub(super) calls: BTreeMap<String, ToolCall>,
    revision: u64,
}

/// 宿主终端动作被取消或释放也清理启动元数据，不把未完成调用留在会话中。
pub(super) struct CallGuard {
    pub(super) state: Arc<State>,
    pub(super) id: String,
}
impl Drop for CallGuard {
    fn drop(&mut self) {
        self.state
            .data
            .lock()
            .expect("桌面会话锁被污染")
            .calls
            .remove(&self.id);
    }
}

/// 可见状态与取消边界独立于 AgentSession，观察任务不延长会话资源所有权。
pub(super) struct State {
    id: String,
    workspace: PathBuf,
    pub(super) data: Mutex<Data>,
    pub(super) closed: CancellationToken,
    changed: Arc<dyn Fn() + Send + Sync>,
    pub(super) tasks: tokio_util::task::TaskTracker,
}
impl State {
    pub(super) fn new(
        workspace: PathBuf,
        instructions: String,
        changed: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            workspace,
            data: Mutex::new(Data {
                history: vec![Message::text(Role::System, instructions)],
                messages: Vec::new(),
                run: None,
                active: None,
                pending_note: None,
                approvals: BTreeMap::new(),
                terminals: BTreeMap::new(),
                calls: BTreeMap::new(),
                revision: 0,
            }),
            closed: CancellationToken::new(),
            changed,
            tasks: tokio_util::task::TaskTracker::new(),
        }
    }
    pub(super) fn ensure_open(&self) -> Result<(), Error> {
        if self.closed.is_cancelled() {
            Err(Error::Config("桌面会话已关闭".into()))
        } else {
            Ok(())
        }
    }
    pub(super) fn snapshot(&self) -> HostSnapshot {
        let data = self.data.lock().expect("桌面会话锁被污染");
        HostSnapshot {
            browser: Default::default(),
            id: self.id.clone(),
            workspace: self.workspace.to_string_lossy().into_owned(),
            revision: data.revision,
            closed: self.closed.is_cancelled(),
            run: data.run.clone(),
            messages: data
                .messages
                .iter()
                .map(|message| {
                    let mut visible = message.clone();
                    for part in &mut visible.content {
                        if let ContentPart::ToolResult(result) = part
                            && result.name == "browser"
                        {
                            // 窗口协议目前只展示工具 JSON；截图保留在模型历史，避免每个 token 都向窗口复制图片字节。
                            result.media.clear();
                        }
                    }
                    visible
                })
                .collect(),
            terminals: data
                .terminals
                .values()
                .map(|entry| entry.view.clone())
                .collect(),
            approvals: data
                .approvals
                .values()
                .map(|pending| pending.view.clone())
                .collect(),
        }
    }
    pub(super) fn notify(&self) {
        {
            let mut data = self.data.lock().expect("桌面会话锁被污染");
            data.revision = data.revision.saturating_add(1);
        }
        (self.changed)();
    }
    pub(super) fn cancel(&self) {
        {
            let mut data = self.data.lock().expect("桌面会话锁被污染");
            if let Some(active) = &data.active {
                active.cancellation.cancel();
            }
            data.approvals.clear();
        }
        self.notify();
    }
    pub(super) fn active_completion(&self) -> Option<watch::Receiver<bool>> {
        self.data
            .lock()
            .expect("桌面会话锁被污染")
            .active
            .as_ref()
            .map(|active| active.done.clone())
    }
    pub(super) fn clear_approvals(&self) {
        self.data
            .lock()
            .expect("桌面会话锁被污染")
            .approvals
            .clear();
        self.notify();
    }
    pub(super) fn clear_retention(&self) {
        for entry in self
            .data
            .lock()
            .expect("桌面会话锁被污染")
            .terminals
            .values_mut()
        {
            entry.retention.take();
        }
    }
    pub(super) fn resolve(&self, id: &str, reply: HostApprovalReply) -> Result<(), Error> {
        self.ensure_open()?;
        let pending = {
            let mut data = self.data.lock().expect("桌面会话锁被污染");
            let current = data
                .approvals
                .get(id)
                .ok_or_else(|| Error::Config("审批已结束、取消或不属于此会话".into()))?;
            if !matches!(
                (&current.view.request, &reply),
                (
                    HostApprovalRequest::Terminal(_),
                    HostApprovalReply::Terminal(_)
                ) | (
                    HostApprovalRequest::Network(_),
                    HostApprovalReply::Network(_)
                ) | (
                    HostApprovalRequest::Browser(_),
                    HostApprovalReply::Browser(_)
                )
            ) {
                return Err(Error::Config("审批决定与申请类型不符".into()));
            }
            data.approvals
                .remove(id)
                .ok_or_else(|| Error::Config("审批已失效".into()))?
        };
        let delivered = pending.sender.send(reply);
        self.notify();
        delivered.map_err(|_| Error::Config("审批等待已经取消，决定未生效".into()))
    }
    pub(super) fn terminal_started(
        &self,
        call_id: String,
        info: TerminalInfo,
        retention: Option<TerminalSubscription>,
        error: Option<String>,
    ) {
        {
            let mut data = self.data.lock().expect("桌面会话锁被污染");
            let tty = data
                .calls
                .get(&call_id)
                .and_then(|call| call.arguments.get("tty"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            data.terminals.insert(
                info.session_id.clone(),
                TerminalEntry {
                    view: HostTerminal {
                        call_id,
                        process: info,
                        bytes: 0,
                        tty,
                        error,
                    },
                    retention,
                },
            );
        }
        self.notify();
    }
    pub(super) fn terminal_output(&self, id: &str, offset: u64) {
        if let Some(entry) = self
            .data
            .lock()
            .expect("桌面会话锁被污染")
            .terminals
            .get_mut(id)
        {
            entry.view.bytes = offset;
        }
        self.notify();
    }
    pub(super) fn terminal_finished(&self, info: TerminalInfo) {
        if let Some(entry) = self
            .data
            .lock()
            .expect("桌面会话锁被污染")
            .terminals
            .get_mut(&info.session_id)
        {
            entry.view.process = info;
        }
        self.notify();
    }
    pub(super) fn terminal_error(&self, id: &str, error: String) {
        if let Some(entry) = self
            .data
            .lock()
            .expect("桌面会话锁被污染")
            .terminals
            .get_mut(id)
        {
            entry.view.error = Some(error);
            entry.retention.take();
        }
        self.notify();
    }
    pub(super) fn acknowledge_terminal(&self, id: &str) {
        if let Some(entry) = self
            .data
            .lock()
            .expect("桌面会话锁被污染")
            .terminals
            .get_mut(id)
        {
            entry.retention.take();
        }
    }
    pub(super) fn append_text(&self, text: String, reasoning: bool) {
        let mut data = self.data.lock().expect("桌面会话锁被污染");
        let Some(index) = data.active.as_ref().and_then(|active| active.draft) else {
            return;
        };
        let parts = &mut data.messages[index].content;
        match parts.last_mut() {
            Some(ContentPart::Text(current)) if !reasoning => current.push_str(&text),
            Some(ContentPart::Reasoning(current)) if reasoning => current.push_str(&text),
            _ => parts.push(if reasoning {
                ContentPart::Reasoning(text)
            } else {
                ContentPart::Text(text)
            }),
        };
        drop(data);
        self.notify();
    }
}
