use super::{MAX_RULES, TerminalApprovalRequest, TerminalApprovalRule, TerminalPermissionGrant};
use crate::CancellationToken;
use crate::tool::terminal::sandbox::Identity;
use std::sync::Mutex;
use tokio::sync::Mutex as AsyncMutex;

/// 会话许可随对话关闭撤销；审批串行化只约束同一会话，不阻塞停止与关闭。
#[derive(Default)]
pub(crate) struct SessionApprovals {
    pub(in crate::tool::terminal) gate: AsyncMutex<()>,
    pub(in crate::tool::terminal) closed: CancellationToken,
    data: Mutex<SessionData>,
}

#[derive(Default)]
struct SessionData {
    grants: Vec<(Identity, TerminalPermissionGrant)>,
    rules: Vec<(Identity, TerminalApprovalRule)>,
}

impl SessionApprovals {
    pub(crate) fn close(&self) {
        self.closed.cancel();
        *self.data.lock().expect("审批会话锁被污染") = SessionData::default();
    }

    pub(in crate::tool::terminal) fn allows(
        &self,
        owner: &Identity,
        request: &TerminalApprovalRequest,
        permissions: &TerminalPermissionGrant,
    ) -> bool {
        let data = self.data.lock().expect("审批会话锁被污染");
        !self.closed.is_cancelled()
            && (data
                .grants
                .iter()
                .any(|(identity, grant)| identity == owner && grant.contains(permissions))
                || data.rules.iter().any(|(identity, rule)| {
                    identity == owner && rule.matches(request, permissions)
                }))
    }

    pub(in crate::tool::terminal) fn grant(
        &self,
        owner: Identity,
        permissions: TerminalPermissionGrant,
    ) -> Result<(), String> {
        let mut data = self.data.lock().expect("审批会话锁被污染");
        self.check(&data)?;
        data.grants.push((owner, permissions));
        Ok(())
    }

    pub(in crate::tool::terminal) fn rule(
        &self,
        owner: Identity,
        rule: TerminalApprovalRule,
    ) -> Result<(), String> {
        let mut data = self.data.lock().expect("审批会话锁被污染");
        self.check(&data)?;
        data.rules.push((owner, rule));
        Ok(())
    }

    fn check(&self, data: &SessionData) -> Result<(), String> {
        if self.closed.is_cancelled() {
            return Err("审批会话已关闭".into());
        }
        if data.grants.len() + data.rules.len() >= MAX_RULES {
            return Err("会话许可已达到 256 项上限".into());
        }
        Ok(())
    }
}
