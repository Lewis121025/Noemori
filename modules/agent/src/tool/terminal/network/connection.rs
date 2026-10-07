use super::{
    NetworkSession, TerminalNetworkApprovalRequest, TerminalNetworkPolicy, TerminalNetworkTarget,
    policy::public_address,
};
use crate::{CancellationToken, ExecutionContext};
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::net::TcpStream;

/// 进程启动时就固定审批归属与取消信号；跨轮继续运行不复用某一次 exec 等待的截止时间。
#[derive(Clone)]
pub(in crate::tool::terminal) struct ProcessNetwork {
    pub(in crate::tool::terminal) session: Arc<NetworkSession>,
    pub(in crate::tool::terminal) terminal_id: String,
    pub(in crate::tool::terminal) call_id: String,
    pub(in crate::tool::terminal) command: String,
    pub(in crate::tool::terminal) workdir: PathBuf,
    pub(in crate::tool::terminal) stop: CancellationToken,
    pub(in crate::tool::terminal) observer: Option<Arc<dyn super::super::TerminalObserver>>,
    pub(in crate::tool::terminal) ingress: Arc<super::IngressRuntime>,
}

/// 单个代理的策略和认证信息；认证失败不能触发目标审批或 DNS 查询。
pub(super) struct Connection {
    pub(super) policy: TerminalNetworkPolicy,
    pub(super) process: ProcessNetwork,
    pub(super) password: String,
    pub(super) tasks: tokio_util::task::TaskTracker,
    pub(super) udp: Arc<super::udp::Hub>,
    pub(super) datagram_flows: Arc<tokio::sync::Semaphore>,
}

impl Connection {
    pub(super) async fn connect(
        &self,
        target: TerminalNetworkTarget,
    ) -> Result<super::upstream::Stream, String> {
        let result = self.connect_target(target.clone()).await;
        self.report(Some(target), result.is_ok(), result.as_ref().err().cloned());
        result
    }

    pub(super) fn report(
        &self,
        target: Option<TerminalNetworkTarget>,
        connected: bool,
        error: Option<String>,
    ) {
        if let Some(observer) = &self.process.observer {
            observer.network(
                &self.process.call_id,
                super::TerminalNetworkObservation {
                    terminal_id: self.process.terminal_id.clone(),
                    target,
                    connected,
                    error,
                },
            );
        }
    }

    async fn connect_target(
        &self,
        target: TerminalNetworkTarget,
    ) -> Result<super::upstream::Stream, String> {
        let addresses = self.resolve(&target, &self.process.stop).await?;
        let context = ExecutionContext::new(self.process.stop.clone(), Duration::from_secs(15))
            .map_err(|error| error.to_string())?;
        if let Some(proxy) = &self.policy.config().upstream_proxy {
            return context
                .wait(super::upstream::connect(proxy, &addresses))
                .await
                .map_err(|error| error.to_string())?;
        }
        context
            .wait(TcpStream::connect(addresses.as_slice()))
            .await
            .map_err(|error| error.to_string())?
            .map(|stream| -> super::upstream::Stream { Box::new(stream) })
            .map_err(|error| format!("目标连接失败：{error}"))
    }

    pub(super) async fn resolve(
        &self,
        target: &TerminalNetworkTarget,
        stop: &CancellationToken,
    ) -> Result<Vec<SocketAddr>, String> {
        let request = TerminalNetworkApprovalRequest {
            session_id: self.process.session.id().into(),
            terminal_id: self.process.terminal_id.clone(),
            call_id: self.process.call_id.clone(),
            command: self.process.command.clone(),
            workdir: self.process.workdir.clone(),
            target: target.clone(),
        };
        let approved = self
            .process
            .session
            .authorize(&self.policy, request, stop)
            .await?;
        let context = ExecutionContext::new(stop.clone(), Duration::from_secs(15))
            .map_err(|error| error.to_string())?;
        let addresses: Vec<_> = context
            .wait(tokio::net::lookup_host((target.host.as_str(), target.port)))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("目标 DNS 解析失败：{error}"))?
            .collect();
        if addresses.is_empty() {
            return Err("目标 DNS 没有返回连接地址".into());
        }
        if !self.policy.permits_private(target, approved)
            && addresses
                .iter()
                .any(|address| !public_address(address.ip()))
        {
            return Err("目标解析落入未经允许的私有或保留地址".into());
        }
        context.check().map_err(|error| error.to_string())?;
        // 后续只使用已校验的地址，禁止连接库再次解析而绕过私有地址检查。
        Ok(addresses)
    }

    pub(super) fn authenticated(&self, username: &[u8], password: &[u8]) -> bool {
        use subtle::ConstantTimeEq;
        username == b"noemori" && bool::from(password.ct_eq(self.password.as_bytes()))
    }
}
