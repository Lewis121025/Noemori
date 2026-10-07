//! 会话拥有跨轮资源；运行取消不会反向关闭会话。

use crate::{CancellationToken, Error, tool::terminal::Manager};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

/// 关闭标记和运行租约共用一把锁，关闭与新运行登记不能交错漏取消。
#[derive(Default)]
struct Runs {
    closed: bool,
    next: u64,
    active: BTreeMap<u64, CancellationToken>,
}

/// 会话身份只存在于宿主内存中；终端资源和运行取消分别管理。
#[derive(Default)]
struct Inner {
    runs: Mutex<Runs>,
    terminals: Manager,
    browser: crate::tool::browser::Manager,
    #[cfg(unix)]
    approvals: crate::tool::terminal::SessionApprovals,
    #[cfg(unix)]
    networks: Arc<crate::tool::terminal::NetworkSession>,
}

/// 显式的对话资源所有者；克隆共享资源，不保存消息历史，也不向模型暴露身份。
///
/// 同一对话的 RunInput 应携带同一会话。宿主须在关闭对话时调用 close；
/// 最后一个会话引用释放时也会触发资源清理，后台进程任务不持有会话的强引用。
#[derive(Clone, Default)]
pub struct AgentSession(Arc<Inner>);

impl std::fmt::Debug for AgentSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentSession")
            .field("closed", &self.is_closed())
            .finish_non_exhaustive()
    }
}

impl AgentSession {
    /// 创建独立会话，不启动线程或子进程。
    pub fn new() -> Self {
        Self::default()
    }

    /// 使用宿主指定的终端磁盘预算创建会话，None 可用于持续流式消费的大输出任务。
    ///
    /// 预算适用于此会话全部终端，模型不能通过命令参数扩大它。
    /// # 错误
    /// 任一预算为零时返回配置错误；不启动进程或创建日志。
    #[cfg(unix)]
    pub fn with_terminal_log_limits(
        limits: crate::tool::terminal::TerminalLogLimits,
    ) -> Result<Self, Error> {
        if limits.process_bytes == Some(0) || limits.session_bytes == Some(0) {
            return Err(Error::Config("终端日志预算必须大于零或不设上限".into()));
        }
        Ok(Self(Arc::new(Inner {
            runs: Mutex::new(Runs::default()),
            terminals: Manager::new(limits),
            browser: Default::default(),
            approvals: Default::default(),
            networks: Default::default(),
        })))
    }

    /// 返回会话是否已经关闭；关闭后不可重新启动运行。
    pub fn is_closed(&self) -> bool {
        self.0.runs.lock().expect("会话锁被污染").closed
    }

    /// 永久关闭会话，取消所有运行，并等待终端进程及输出读取任务完成清理。
    ///
    /// 可重复调用；即使等待被取消，清理仍由会话拥有的后台任务继续执行。
    /// # 错误
    /// 操作系统拒绝终止、回收进程或清理输出管道失败时返回基础设施错误。
    pub async fn close(&self) -> Result<(), Error> {
        {
            let mut runs = self.0.runs.lock().expect("会话锁被污染");
            runs.closed = true;
            for token in runs.active.values() {
                token.cancel();
            }
        }
        #[cfg(unix)]
        self.0.approvals.close();
        #[cfg(unix)]
        self.0.networks.close();
        let (terminal, browser) = tokio::join!(self.0.terminals.close(), self.0.browser.close());
        let errors: Vec<_> = [terminal, browser]
            .into_iter()
            .filter_map(Result::err)
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Error::ToolInfrastructure(errors.join("；")))
        }
    }

    pub(crate) fn terminals(&self) -> &Manager {
        &self.0.terminals
    }

    pub(crate) fn browser(&self) -> &crate::tool::browser::Manager {
        &self.0.browser
    }

    /// 读取会话浏览器状态与迟到回执；不会启动浏览器或消费任何观察。
    pub fn browser_snapshot(&self) -> crate::tool::browser::BrowserSnapshot {
        self.0.browser.snapshot()
    }

    #[cfg(unix)]
    pub(crate) fn approvals(&self) -> &crate::tool::terminal::SessionApprovals {
        &self.0.approvals
    }

    /// 返回宿主会话的稳定身份，供终端目标审批与桌面会话关联；克隆保持相同身份。
    #[cfg(unix)]
    pub fn id(&self) -> &str {
        self.0.networks.id()
    }

    #[cfg(unix)]
    pub(crate) fn networks(&self) -> &Arc<crate::tool::terminal::NetworkSession> {
        &self.0.networks
    }

    pub(crate) fn register(&self, token: CancellationToken) -> Result<RunLease, Error> {
        let mut runs = self.0.runs.lock().expect("会话锁被污染");
        if runs.closed {
            return Err(Error::Config("Agent 会话已关闭".into()));
        }
        let id = runs.next;
        runs.next = runs
            .next
            .checked_add(1)
            .ok_or_else(|| Error::Config("会话运行计数耗尽".into()))?;
        runs.active.insert(id, token.clone());
        Ok(RunLease {
            owner: Arc::downgrade(&self.0),
            id,
            token,
        })
    }
}

/// 弱引用避免运行租约反向延长会话生命周期；释放租约即取消其子任务。
pub(crate) struct RunLease {
    owner: Weak<Inner>,
    id: u64,
    token: CancellationToken,
}

impl Drop for RunLease {
    fn drop(&mut self) {
        self.token.cancel();
        if let Some(owner) = self.owner.upgrade() {
            owner
                .runs
                .lock()
                .expect("会话锁被污染")
                .active
                .remove(&self.id);
        }
    }
}
