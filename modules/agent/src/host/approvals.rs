use super::{
    contract::*,
    state::{Pending, State},
};
use crate::{
    ExecutionContext,
    tool::terminal::{
        TerminalApprovalDecision, TerminalApprovalRequest, TerminalApprover,
        TerminalNetworkApprovalDecision, TerminalNetworkApprovalRequest, TerminalNetworkApprover,
    },
};
use std::sync::{Arc, Weak};
use tokio::sync::oneshot;

/// 审批通知只持弱状态引用，等待归属于当前运行和目标连接的取消边界。
pub(super) struct Gate(pub(super) Weak<State>);
struct PendingGuard {
    state: Arc<State>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.state
            .data
            .lock()
            .expect("桌面会话锁被污染")
            .approvals
            .remove(&self.id);
        self.state.notify();
    }
}
impl Gate {
    async fn wait(
        &self,
        request: HostApprovalRequest,
        context: ExecutionContext,
    ) -> Result<HostApprovalReply, String> {
        let state = self.0.upgrade().ok_or("桌面宿主已释放")?;
        state.ensure_open().map_err(|error| error.to_string())?;
        context.check().map_err(|error| error.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, reply) = oneshot::channel();
        {
            let mut data = state.data.lock().expect("桌面会话锁被污染");
            data.approvals.insert(
                id.clone(),
                Pending {
                    view: HostApproval {
                        id: id.clone(),
                        request,
                    },
                    sender,
                },
            );
        }
        let _guard = PendingGuard {
            state: state.clone(),
            id,
        };
        state.notify();
        tokio::select! {biased;_=state.closed.cancelled()=>Err("桌面会话已关闭".into()),result=context.wait(reply)=>result.map_err(|error|error.to_string())?.map_err(|_|"审批等待已取消".into())}
    }
}
#[async_trait::async_trait]
impl TerminalApprover for Gate {
    async fn approve(
        &self,
        request: TerminalApprovalRequest,
        context: ExecutionContext,
    ) -> Result<TerminalApprovalDecision, String> {
        match self
            .wait(HostApprovalRequest::Terminal(Box::new(request)), context)
            .await?
        {
            HostApprovalReply::Terminal(decision) => Ok(decision),
            HostApprovalReply::Network(_)
            | HostApprovalReply::Browser(_)
            | HostApprovalReply::Ui(_) => Err("审批类型不符".into()),
        }
    }
}
#[async_trait::async_trait]
impl TerminalNetworkApprover for Gate {
    async fn approve(
        &self,
        request: TerminalNetworkApprovalRequest,
        context: ExecutionContext,
    ) -> Result<TerminalNetworkApprovalDecision, String> {
        match self
            .wait(HostApprovalRequest::Network(request), context)
            .await?
        {
            HostApprovalReply::Network(decision) => Ok(decision),
            HostApprovalReply::Terminal(_)
            | HostApprovalReply::Browser(_)
            | HostApprovalReply::Ui(_) => Err("审批类型不符".into()),
        }
    }
}

#[async_trait::async_trait]
impl crate::tool::browser::BrowserApprover for Gate {
    async fn approve(
        &self,
        request: crate::tool::browser::BrowserAccessRequest,
        context: ExecutionContext,
    ) -> Result<crate::tool::browser::BrowserAccessDecision, String> {
        match self
            .wait(HostApprovalRequest::Browser(request), context)
            .await?
        {
            HostApprovalReply::Browser(decision) => Ok(decision),
            HostApprovalReply::Terminal(_)
            | HostApprovalReply::Network(_)
            | HostApprovalReply::Ui(_) => Err("审批类型不符".into()),
        }
    }
}

#[async_trait::async_trait]
impl crate::tool::ui::computer::UiApprover for Gate {
    async fn approve(
        &self,
        request: crate::tool::ui::computer::UiAccessRequest,
        context: ExecutionContext,
    ) -> Result<crate::tool::ui::computer::UiAccessDecision, String> {
        match self.wait(HostApprovalRequest::Ui(request), context).await? {
            HostApprovalReply::Ui(decision) => Ok(decision),
            _ => Err("审批类型不符".into()),
        }
    }
}
