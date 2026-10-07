use super::{
    TerminalNetworkApprovalDecision as Decision, TerminalNetworkApprovalRequest,
    TerminalNetworkDecision, TerminalNetworkPolicy, TerminalNetworkTarget,
};
use crate::{CancellationToken, ExecutionContext};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

const MAX_TARGETS: usize = 256;

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    policy: uuid::Uuid,
    target: TerminalNetworkTarget,
}

/// 所有许可都属于宿主会话；策略身份、协议和端口不同的目标不会共享审批。
pub(crate) struct NetworkSession {
    id: String,
    closed: CancellationToken,
    data: Mutex<Data>,
}

#[derive(Default)]
struct Data {
    grants: HashSet<Key>,
    pending: HashMap<Key, Arc<Pending>>,
}

/// 当前审批组的所有等待者共享结果；最后一个等待者离开即取消宿主审批。
struct Pending {
    participants: Mutex<HashMap<uuid::Uuid, CancellationToken>>,
    cancellation: CancellationToken,
    result: watch::Sender<Option<Result<Decision, String>>>,
}

struct Participant {
    pending: Arc<Pending>,
    id: uuid::Uuid,
}
impl Drop for Participant {
    fn drop(&mut self) {
        let mut participants = self
            .pending
            .participants
            .lock()
            .expect("网络审批参与者锁被污染");
        participants.remove(&self.id);
        if participants.is_empty() {
            self.pending.cancellation.cancel();
        }
    }
}

/// 宿主任务在首次调度前就有完成守卫；运行时关闭也会唤醒所有等待者并撤销未提交许可。
struct Completion {
    session: Arc<NetworkSession>,
    key: Key,
    pending: Arc<Pending>,
    finished: bool,
}

impl Completion {
    fn finish(&mut self, mut result: Result<Decision, String>) {
        let mut data = self.session.data.lock().expect("网络审批会话锁被污染");
        if self.session.closed.is_cancelled()
            || self.pending.cancellation.is_cancelled()
            || !self
                .pending
                .participants
                .lock()
                .expect("网络审批参与者锁被污染")
                .values()
                .any(|stop| !stop.is_cancelled())
        {
            result = Err("网络审批已取消，未保存许可".into());
        }
        if data
            .pending
            .get(&self.key)
            .is_some_and(|pending| Arc::ptr_eq(pending, &self.pending))
        {
            data.pending.remove(&self.key);
            if matches!(result, Ok(Decision::AllowForSession)) {
                data.grants.insert(self.key.clone());
            }
        }
        self.pending.result.send_replace(Some(result));
        self.finished = true;
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(Err("网络审批任务提前结束，未授予许可".into()));
        }
    }
}

impl Default for NetworkSession {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().simple().to_string(),
            closed: CancellationToken::new(),
            data: Mutex::new(Data::default()),
        }
    }
}

impl NetworkSession {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn close(&self) {
        self.closed.cancel();
        *self.data.lock().expect("网络审批会话锁被污染") = Data::default();
    }

    /// 返回是否由宿主动态批准；静态拒绝不请求审批，静态允许不扩大私有地址范围。
    pub(super) async fn authorize(
        self: &Arc<Self>,
        policy: &TerminalNetworkPolicy,
        mut request: TerminalNetworkApprovalRequest,
        stop: &CancellationToken,
    ) -> Result<bool, String> {
        if stop.is_cancelled() || self.closed.is_cancelled() {
            return Err("目标请求所属进程或会话已关闭".into());
        }
        match policy
            .decision(&request.target)
            .map_err(|error| error.to_string())?
        {
            Some(TerminalNetworkDecision::Deny) => return Err("宿主网络规则禁止此目标".into()),
            Some(TerminalNetworkDecision::Allow) => return Ok(false),
            None => {}
        }
        let approver = policy
            .approver()
            .ok_or("此目标未获得网络许可，宿主未提供目标审批入口")?
            .clone();
        let key = Key {
            policy: policy.id(),
            target: request.target.clone(),
        };
        let participant_id = uuid::Uuid::new_v4();
        let (pending, leader) = {
            let mut data = self.data.lock().expect("网络审批会话锁被污染");
            if self.closed.is_cancelled() {
                return Err("网络审批会话已关闭".into());
            }
            if data.grants.contains(&key) {
                return Ok(true);
            }
            let (pending, leader) = if let Some(pending) = data
                .pending
                .get(&key)
                .filter(|pending| !pending.cancellation.is_cancelled())
            {
                (pending.clone(), false)
            } else {
                data.pending.remove(&key);
                if data.pending.len() + data.grants.len() >= MAX_TARGETS {
                    return Err("会话网络许可和待审批目标达到 256 项上限".into());
                }
                let pending = Arc::new(Pending {
                    participants: Mutex::new(HashMap::new()),
                    cancellation: self.closed.child_token(),
                    result: watch::channel(None).0,
                });
                data.pending.insert(key.clone(), pending.clone());
                (pending, true)
            };
            pending
                .participants
                .lock()
                .expect("网络审批参与者锁被污染")
                .insert(participant_id, stop.clone());
            (pending, leader)
        };
        let participant = Participant {
            pending: pending.clone(),
            id: participant_id,
        };
        let mut result = pending.result.subscribe();
        if leader {
            request.session_id = self.id.clone();
            let context =
                ExecutionContext::new(pending.cancellation.clone(), Duration::from_secs(30))
                    .map_err(|error| error.to_string())?;
            let mut completion = Completion {
                session: self.clone(),
                key,
                pending,
                finished: false,
            };
            tokio::spawn(async move {
                let decision = context
                    .wait(approver.approve(request, context.clone()))
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|decision| decision);
                completion.finish(decision);
            });
        }
        let outcome = loop {
            if let Some(decision) = result.borrow().clone() {
                break decision;
            }
            tokio::select! {
                biased;
                _ = self.closed.cancelled() => break Err("网络审批会话已关闭".into()),
                _ = stop.cancelled() => break Err("请求目标的进程已停止".into()),
                changed = result.changed() => if changed.is_err() { break Err("网络审批通道已关闭".into()); },
            }
        };
        drop(participant);
        if stop.is_cancelled() || self.closed.is_cancelled() {
            return Err("目标请求所属进程或会话已关闭".into());
        }
        match outcome? {
            Decision::AllowOnce | Decision::AllowForSession => Ok(true),
            Decision::Deny(reason) => Err(format!("宿主拒绝目标网络访问：{reason}")),
        }
    }
}

#[cfg(test)]
#[path = "../../../../../../test/agent/terminal/unit/network_session.rs"]
mod tests;
