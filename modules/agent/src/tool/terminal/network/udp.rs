use super::{
    TerminalNetworkProtocol, TerminalNetworkTarget,
    connection::Connection,
    datagram_codec::{self, MAX_DATAGRAM},
    datagram_transport::Transport,
};
use crate::{CancellationToken, ExecutionContext};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
#[cfg(target_os = "linux")]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UdpSocket;
#[cfg(target_os = "linux")]
use tokio::sync::mpsc;
use tokio::sync::{OnceCell, OwnedSemaphorePermit, Semaphore};

/// 数据报必须归属于仍存活的已认证 SOCKS 控制连接；来源端口确认后不再迁移。
pub(super) struct Hub {
    pub(super) port: u16,
    entries: Mutex<Vec<Arc<Association>>>,
    packets: Arc<Semaphore>,
}

struct Binding {
    peer: Option<SocketAddr>,
    reply: Option<Reply>,
}
struct Association {
    id: uuid::Uuid,
    ip: IpAddr,
    expected_port: u16,
    binding: Mutex<Binding>,
    closed: CancellationToken,
    flows: Mutex<HashMap<TerminalNetworkTarget, Arc<OnceCell<Arc<Flow>>>>>,
    connection: Weak<Connection>,
}
struct Flow {
    id: uuid::Uuid,
    transport: Transport,
    _permit: OwnedSemaphorePermit,
}

#[derive(Clone)]
enum Reply {
    Direct {
        socket: Arc<UdpSocket>,
        peer: SocketAddr,
    },
    #[cfg(target_os = "linux")]
    Relay(mpsc::Sender<Vec<u8>>),
}
impl Reply {
    async fn send(&self, bytes: Vec<u8>) -> Result<(), String> {
        match self {
            Self::Direct { socket, peer } => {
                socket
                    .send_to(&bytes, *peer)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(())
            }
            #[cfg(target_os = "linux")]
            Self::Relay(sender) => sender.send(bytes).await.map_err(|error| error.to_string()),
        }
    }
}

pub(super) struct Lease {
    hub: Arc<Hub>,
    association: Arc<Association>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.association.closed.cancel();
        self.association
            .flows
            .lock()
            .expect("UDP 目标锁被污染")
            .clear();
        self.hub
            .entries
            .lock()
            .expect("UDP 关联锁被污染")
            .retain(|entry| entry.id != self.association.id);
    }
}

impl Hub {
    pub(super) fn new(port: u16) -> Self {
        Self {
            port,
            entries: Mutex::new(Vec::new()),
            packets: Arc::new(Semaphore::new(128)),
        }
    }

    pub(super) fn register(
        self: &Arc<Self>,
        ip: IpAddr,
        expected_port: u16,
        connection: &Arc<Connection>,
    ) -> Result<Lease, String> {
        let mut entries = self.entries.lock().expect("UDP 关联锁被污染");
        if entries.len() >= 128 {
            return Err("UDP 关联达到 128 项上限".into());
        }
        let ip = ip.to_canonical();
        for entry in entries
            .iter()
            .filter(|entry| entry.ip == ip && !entry.closed.is_cancelled())
        {
            let binding = entry.binding.lock().expect("UDP 来源锁被污染");
            if (entry.expected_port == 0 && binding.peer.is_none())
                || (expected_port != 0
                    && (entry.expected_port == expected_port
                        || binding
                            .peer
                            .is_some_and(|peer| peer.port() == expected_port)))
            {
                return Err("UDP 来源无法唯一归属于本控制连接，请使用独立的显式来源端口".into());
            }
        }
        let association = Arc::new(Association {
            id: uuid::Uuid::new_v4(),
            ip,
            expected_port,
            binding: Mutex::new(Binding {
                peer: None,
                reply: None,
            }),
            closed: connection.process.stop.child_token(),
            flows: Mutex::new(HashMap::new()),
            connection: Arc::downgrade(connection),
        });
        entries.push(association.clone());
        Ok(Lease {
            hub: self.clone(),
            association,
        })
    }

    fn find(&self, peer: SocketAddr, reply: Reply) -> Result<Arc<Association>, String> {
        let peer = SocketAddr::new(peer.ip().to_canonical(), peer.port());
        let entries = self.entries.lock().expect("UDP 关联锁被污染");
        for entry in entries
            .iter()
            .filter(|entry| entry.ip == peer.ip() && !entry.closed.is_cancelled())
        {
            let mut binding = entry.binding.lock().expect("UDP 来源锁被污染");
            if binding.peer == Some(peer)
                || (binding.peer.is_none() && entry.expected_port == peer.port())
            {
                binding.peer = Some(peer);
                binding.reply = Some(reply);
                return Ok(entry.clone());
            }
        }
        for entry in entries.iter().filter(|entry| {
            entry.ip == peer.ip() && entry.expected_port == 0 && !entry.closed.is_cancelled()
        }) {
            let mut binding = entry.binding.lock().expect("UDP 来源锁被污染");
            if binding.peer.is_none() {
                binding.peer = Some(peer);
                binding.reply = Some(reply);
                return Ok(entry.clone());
            }
        }
        Err("UDP 来源没有已认证的活动控制连接".into())
    }

    async fn deliver(
        self: &Arc<Self>,
        bytes: Vec<u8>,
        peer: SocketAddr,
        reply: Reply,
        connection: Arc<Connection>,
    ) -> Result<(), String> {
        let packet = datagram_codec::decode(&bytes)?;
        let target =
            TerminalNetworkTarget::new(&packet.host, packet.port, TerminalNetworkProtocol::Udp)
                .map_err(|error| error.to_string())?;
        let association = self.find(peer, reply)?;
        if !association
            .connection
            .upgrade()
            .is_some_and(|owner| Arc::ptr_eq(&owner, &connection))
        {
            return Err("UDP 控制连接的进程归属已经变化".into());
        }
        let cell = {
            let mut flows = association.flows.lock().expect("UDP 目标锁被污染");
            if !flows.contains_key(&target) && flows.len() >= 32 {
                return Err("单个 UDP 关联达到 32 个目标上限".into());
            }
            flows.entry(target.clone()).or_default().clone()
        };
        let initialize = async {
            let permit = connection
                .datagram_flows
                .clone()
                .try_acquire_owned()
                .map_err(|_| "UDP 目标连接达到 64 项上限")?;
            let addresses = connection.resolve(&target, &association.closed).await?;
            let context =
                ExecutionContext::new(association.closed.clone(), Duration::from_secs(15))
                    .map_err(|error| error.to_string())?;
            let transport = context
                .wait(Transport::connect(
                    connection.policy.config().upstream_proxy.as_ref(),
                    &addresses,
                ))
                .await
                .map_err(|error| error.to_string())??;
            let flow = Arc::new(Flow {
                id: uuid::Uuid::new_v4(),
                transport,
                _permit: permit,
            });
            connection.report(Some(target.clone()), true, None);
            let receiving = flow.clone();
            let owner = association.clone();
            let destination = target.clone();
            let state = connection.clone();
            connection.tasks.spawn(async move {
                receive(owner, receiving, destination, state).await;
            });
            Ok::<_, String>(flow)
        };
        let result = tokio::select! {biased;_=association.closed.cancelled()=>return Err("UDP 控制连接已经关闭".into()),result=cell.get_or_try_init(||initialize)=>result};
        let flow = match result {
            Ok(flow) => flow,
            Err(error) => {
                let mut flows = association.flows.lock().expect("UDP 目标锁被污染");
                if Arc::strong_count(&cell) == 2
                    && flows
                        .get(&target)
                        .is_some_and(|entry| Arc::ptr_eq(entry, &cell))
                    && cell.get().is_none()
                {
                    flows.remove(&target);
                }
                return Err(error);
            }
        };
        if association.closed.is_cancelled() {
            return Err("UDP 控制连接已经关闭".into());
        }
        flow.transport.send(packet.payload).await?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(super) async fn listen(
        self: Arc<Self>,
        socket: Arc<UdpSocket>,
        stop: CancellationToken,
        fallback: Option<Arc<Connection>>,
    ) -> Result<(), String> {
        let mut bytes = vec![0; MAX_DATAGRAM];
        loop {
            let (count, peer) = tokio::select! {biased;_=stop.cancelled()=>break,result=socket.recv_from(&mut bytes)=>result.map_err(|error|error.to_string())?};
            self.dispatch(
                socket.clone(),
                bytes[..count].to_vec(),
                peer,
                fallback.as_ref(),
            );
        }
        Ok(())
    }

    /// 接收入口只提供返回路径；每个数据报仍由已认证控制连接决定进程、策略和并发预算。
    pub(super) fn dispatch(
        self: &Arc<Self>,
        socket: Arc<UdpSocket>,
        packet: Vec<u8>,
        peer: SocketAddr,
        fallback: Option<&Arc<Connection>>,
    ) {
        let reply = Reply::Direct { socket, peer };
        let state = match self.find(peer, reply.clone()).and_then(|association| {
            association
                .connection
                .upgrade()
                .ok_or_else(|| "UDP 进程归属已释放".into())
        }) {
            Ok(state) => state,
            Err(error) => {
                if let Some(fallback) = fallback {
                    fallback.report(None, false, Some(error));
                }
                return;
            }
        };
        let permit = match self.packets.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(error) => {
                state.report(None, false, Some(format!("UDP 转发并发预算已满：{error}")));
                return;
            }
        };
        let hub = self.clone();
        state.tasks.clone().spawn(async move {
            let _permit = permit;
            if let Err(error) = hub.deliver(packet, peer, reply, state.clone()).await {
                state.report(None, false, Some(error));
            }
        });
    }

    #[cfg(target_os = "linux")]
    pub(super) async fn relay<S: AsyncRead + AsyncWrite + Unpin>(
        self: Arc<Self>,
        mut stream: S,
        connection: Arc<Connection>,
    ) -> Result<(), String> {
        let port = stream.read_u16().await.map_err(|error| error.to_string())?;
        if port == 0 {
            return Err("UDP 转发来源端口不能为空".into());
        }
        let peer = SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), port);
        let (sender, mut replies) = mpsc::channel(8);
        let association = match self.find(peer, Reply::Relay(sender.clone())) {
            Ok(association) => association,
            Err(error) => {
                stream
                    .write_u8(1)
                    .await
                    .map_err(|error| error.to_string())?;
                connection.report(None, false, Some(error));
                return Ok(());
            }
        };
        stream
            .write_u8(0)
            .await
            .map_err(|error| error.to_string())?;
        let (mut read, mut write) = tokio::io::split(stream);
        let incoming = async {
            while let Some(bytes) = super::frames::read_frame(&mut read).await? {
                if let Err(error) = self
                    .deliver(
                        bytes,
                        peer,
                        Reply::Relay(sender.clone()),
                        connection.clone(),
                    )
                    .await
                {
                    connection.report(None, false, Some(error));
                }
            }
            Ok::<_, String>(())
        };
        let outgoing = async {
            while let Some(bytes) = replies.recv().await {
                super::frames::write_frame(&mut write, &bytes).await?;
            }
            Ok::<_, String>(())
        };
        tokio::select! {biased;_=association.closed.cancelled()=>Ok(()),result=incoming=>result,result=outgoing=>result}
    }
}

async fn receive(
    association: Arc<Association>,
    flow: Arc<Flow>,
    target: TerminalNetworkTarget,
    connection: Arc<Connection>,
) {
    let operation = async {
        let mut bytes = vec![0; MAX_DATAGRAM];
        loop {
            let (source, count) = flow.transport.receive(&mut bytes).await?;
            let packet = datagram_codec::encode(source, &bytes[..count])?;
            let reply = association
                .binding
                .lock()
                .expect("UDP 来源锁被污染")
                .reply
                .clone()
                .ok_or("UDP 控制连接没有返回路径")?;
            reply.send(packet).await?;
        }
    };
    tokio::select! {biased;_=association.closed.cancelled()=>{},result=operation=>{let result:Result<(),String>=result;if let Err(error)=result {connection.report(Some(target.clone()),false,Some(error));}}}
    let mut flows = association.flows.lock().expect("UDP 目标锁被污染");
    if flows
        .get(&target)
        .and_then(|cell| cell.get())
        .is_some_and(|current| current.id == flow.id)
    {
        flows.remove(&target);
    }
}
