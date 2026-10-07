use super::{
    TerminalProxyListener, TerminalProxyListenerInfo, TerminalProxyProtocol, connection::Connection,
};
use crate::CancellationToken;
use std::{
    collections::{BTreeMap, HashMap},
    net::SocketAddr,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::{
    net::{TcpListener, UdpSocket},
    sync::{Notify, Semaphore},
};
use tokio_util::task::TaskTracker;

static LISTENERS: Mutex<BTreeMap<SocketAddr, Weak<Server>>> = Mutex::new(BTreeMap::new());

/// 配置的监听入口属于宿主工具；后台进程保留同一资源，纯策略和审批记录不持有端口。
#[derive(Default)]
pub(in crate::tool::terminal) struct IngressRuntime {
    owners: Mutex<BTreeMap<SocketAddr, OwnedEndpoint>>,
}

struct OwnedEndpoint {
    owner: Arc<Ownership>,
    protocols: Protocols,
}
struct Ownership {
    server: Arc<Server>,
}
impl Drop for Ownership {
    fn drop(&mut self) {
        self.server.owners.fetch_sub(1, Ordering::AcqRel);
        self.server.changed.notify_one();
    }
}

/// 一条配置地址内的协议选择；相同地址合并所有权，凭据仍限制本进程可使用的协议。
#[derive(Clone, Copy, Default)]
pub(super) struct Protocols {
    pub(super) http: bool,
    pub(super) socks: bool,
}
impl Protocols {
    fn insert(&mut self, protocol: TerminalProxyProtocol) {
        match protocol {
            TerminalProxyProtocol::Http => self.http = true,
            TerminalProxyProtocol::Socks5 => self.socks = true,
        }
    }
    fn values(self) -> Vec<TerminalProxyProtocol> {
        let mut values = Vec::new();
        if self.http {
            values.push(TerminalProxyProtocol::Http);
        }
        if self.socks {
            values.push(TerminalProxyProtocol::Socks5);
        }
        values
    }
    pub(super) fn allows(self, protocol: TerminalProxyProtocol) -> bool {
        match protocol {
            TerminalProxyProtocol::Http => self.http,
            TerminalProxyProtocol::Socks5 => self.socks,
        }
    }
}

struct Route {
    connection: Weak<Connection>,
    protocols: Protocols,
}
struct Sockets {
    tcp: std::net::TcpListener,
    udp: std::net::UdpSocket,
}

/// 监听与凭据归属分别持有；未知客户端不能在认证前选择目标、发起审批或解析 DNS。
pub(super) struct Server {
    configured: SocketAddr,
    pub(super) bound: SocketAddr,
    originals: Mutex<Option<Sockets>>,
    owners: AtomicUsize,
    closed: AtomicBool,
    changed: Notify,
    pub(super) stop: CancellationToken,
    routes: Mutex<HashMap<String, Route>>,
    pub(super) tasks: TaskTracker,
    pub(super) udp: Arc<super::udp::Hub>,
}

/// 进程退出先撤销凭据；宿主工具仍在时监听可继续服务下一次执行。
pub(super) struct Registration {
    server: Arc<Server>,
    password: String,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.server
            .routes
            .lock()
            .expect("共享代理归属锁被污染")
            .remove(&self.password);
    }
}

impl IngressRuntime {
    /// 在分配进程私有临时端口前预留宿主配置端口，避免两者在同一次启动中冲突。
    pub(super) fn prepare(
        &self,
        config: &super::TerminalNetworkConfig,
    ) -> Result<Vec<PreparedEndpoint>, String> {
        let mut selected = BTreeMap::<SocketAddr, (TerminalProxyListener, Protocols)>::new();
        for (listener, protocol) in [
            (&config.http_listener, TerminalProxyProtocol::Http),
            (&config.socks_listener, TerminalProxyProtocol::Socks5),
        ] {
            if let Some(listener) = listener {
                selected
                    .entry(listener.address)
                    .or_insert_with(|| (listener.clone(), Protocols::default()))
                    .1
                    .insert(protocol);
            }
        }
        let mut owners = self.owners.lock().expect("共享代理宿主锁被污染");
        let mut prepared = BTreeMap::new();
        for (address, (listener, protocols)) in &selected {
            if owners
                .get(address)
                .is_none_or(|entry| entry.owner.server.closed.load(Ordering::Acquire))
            {
                prepared.insert(
                    *address,
                    OwnedEndpoint {
                        owner: acquire(listener)?,
                        protocols: *protocols,
                    },
                );
            }
        }
        // 全部地址准备成功后才交付所有权与凭据；第二个端口失败不能留下部分生效的入口。
        owners.extend(prepared);
        let mut prepared_endpoints = Vec::new();
        for (address, (_, protocols)) in selected {
            let entry = owners.get_mut(&address).ok_or("共享代理所有权未建立")?;
            entry.protocols.http |= protocols.http;
            entry.protocols.socks |= protocols.socks;
            let server = entry.owner.server.clone();
            prepared_endpoints.push(PreparedEndpoint { server, protocols });
        }
        Ok(prepared_endpoints)
    }

    pub(in crate::tool::terminal) fn status(&self) -> Vec<TerminalProxyListenerInfo> {
        self.owners
            .lock()
            .expect("共享代理宿主锁被污染")
            .values()
            .filter(|entry| !entry.owner.server.closed.load(Ordering::Acquire))
            .map(|entry| TerminalProxyListenerInfo {
                configured_address: entry.owner.server.configured,
                bound_address: entry.owner.server.bound,
                protocols: entry.protocols.values(),
                active_terminals: entry
                    .owner
                    .server
                    .routes
                    .lock()
                    .expect("共享代理归属锁被污染")
                    .values()
                    .filter_map(|route| route.connection.upgrade())
                    .filter(|connection| !connection.process.stop.is_cancelled())
                    .count(),
            })
            .collect()
    }
}

/// 地址已经整体预留，进程身份确认后才发布凭据；启动准备不提前接受任何目标请求。
pub(super) struct PreparedEndpoint {
    server: Arc<Server>,
    protocols: Protocols,
}
impl PreparedEndpoint {
    pub(super) fn register(self, connection: &Arc<Connection>) -> Registration {
        self.server
            .routes
            .lock()
            .expect("共享代理归属锁被污染")
            .insert(
                connection.password.clone(),
                Route {
                    connection: Arc::downgrade(connection),
                    protocols: self.protocols,
                },
            );
        Registration {
            server: self.server,
            password: connection.password.clone(),
        }
    }
}

fn acquire(listener: &TerminalProxyListener) -> Result<Arc<Ownership>, String> {
    let mut registry = LISTENERS.lock().expect("共享监听目录锁被污染");
    if let Some(server) = registry.get(&listener.address).and_then(Weak::upgrade)
        && !server.closed.load(Ordering::Acquire)
    {
        server.owners.fetch_add(1, Ordering::AcqRel);
        return Ok(Arc::new(Ownership { server }));
    }
    let sockets = bind(listener.address)?;
    let bound = sockets
        .tcp
        .local_addr()
        .map_err(|error| error.to_string())?;
    let tcp = sockets.tcp.try_clone().map_err(|error| error.to_string())?;
    tcp.set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let tcp = TcpListener::from_std(tcp).map_err(|error| error.to_string())?;
    let udp = sockets.udp.try_clone().map_err(|error| error.to_string())?;
    udp.set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let udp = Arc::new(UdpSocket::from_std(udp).map_err(|error| error.to_string())?);
    let server = Arc::new(Server {
        configured: listener.address,
        bound,
        originals: Mutex::new(Some(sockets)),
        owners: AtomicUsize::new(1),
        closed: AtomicBool::new(false),
        changed: Notify::new(),
        stop: CancellationToken::new(),
        routes: Mutex::new(HashMap::new()),
        tasks: TaskTracker::new(),
        udp: Arc::new(super::udp::Hub::new(bound.port())),
    });
    registry.insert(listener.address, Arc::downgrade(&server));
    let running = server.clone();
    let guard = RunGuard {
        server: server.clone(),
        tcp: Some(tcp),
        udp: Some(udp),
    };
    drop(registry);
    tokio::spawn(async move {
        running.run(guard).await;
    });
    Ok(Arc::new(Ownership { server }))
}

fn bind(address: SocketAddr) -> Result<Sockets, String> {
    for _ in 0..16 {
        let tcp = std::net::TcpListener::bind(address)
            .map_err(|error| format!("共享代理 TCP 监听无法建立：{error}"))?;
        let actual = tcp.local_addr().map_err(|error| error.to_string())?;
        match std::net::UdpSocket::bind(actual) {
            Ok(udp) => return Ok(Sockets { tcp, udp }),
            Err(error) if address.port() == 0 && error.kind() == std::io::ErrorKind::AddrInUse => {}
            Err(error) => return Err(format!("共享代理 UDP 监听无法建立：{error}")),
        }
    }
    Err("无法预留同一 TCP/UDP 共享代理端口".into())
}

impl Server {
    pub(super) fn protocol_available(&self, protocol: TerminalProxyProtocol) -> bool {
        self.routes
            .lock()
            .expect("共享代理归属锁被污染")
            .values()
            .any(|route| {
                route.protocols.allows(protocol)
                    && route.connection.upgrade().is_some_and(|connection| {
                        !connection.process.stop.is_cancelled()
                            && (protocol != TerminalProxyProtocol::Socks5
                                || connection.policy.config().enable_socks5)
                    })
            })
    }

    pub(super) fn authenticated(
        &self,
        username: &[u8],
        password: &[u8],
        protocol: TerminalProxyProtocol,
    ) -> Option<Arc<Connection>> {
        if username != b"noemori" {
            return None;
        }
        let password = std::str::from_utf8(password).ok()?;
        let routes = self.routes.lock().expect("共享代理归属锁被污染");
        let route = routes.get(password)?;
        let connection = route.connection.upgrade()?;
        (route.protocols.allows(protocol)
            && !connection.process.stop.is_cancelled()
            && connection.authenticated(username, password.as_bytes()))
        .then_some(connection)
    }

    async fn run(self: Arc<Self>, mut guard: RunGuard) {
        let slots = Arc::new(Semaphore::new(128));
        let mut bytes = vec![0; super::frames::MAX_DATAGRAM];
        enum Event {
            Tcp(std::io::Result<(tokio::net::TcpStream, SocketAddr)>),
            Udp(std::io::Result<(usize, SocketAddr)>),
            Owners,
        }
        loop {
            let event = {
                let tcp = guard.tcp.as_ref().expect("共享 TCP 监听尚未关闭");
                let udp = guard.udp.as_ref().expect("共享 UDP 监听尚未关闭");
                tokio::select! {
                    result = tcp.accept() => Event::Tcp(result),
                    result = udp.recv_from(&mut bytes) => Event::Udp(result),
                    _ = self.changed.notified() => Event::Owners,
                }
            };
            let error = match event {
                Event::Tcp(Ok((socket, peer))) => {
                    if let Ok(permit) = slots.clone().try_acquire_owned() {
                        let server = self.clone();
                        self.tasks.spawn(async move {
                            super::shared_handshake::serve(socket, server, peer, permit).await;
                        });
                    }
                    continue;
                }
                Event::Udp(Ok((count, peer))) => {
                    self.udp.dispatch(
                        guard.udp.as_ref().expect("共享 UDP 监听尚未关闭").clone(),
                        bytes[..count].to_vec(),
                        peer,
                        None,
                    );
                    continue;
                }
                Event::Tcp(Err(error)) | Event::Udp(Err(error)) => Some(error.to_string()),
                Event::Owners => None,
            };
            if guard.close(error.as_deref(), false) {
                break;
            }
        }
        self.tasks.close();
        self.tasks.wait().await;
    }

    fn shutdown(&self, registry: &mut BTreeMap<SocketAddr, Weak<Server>>) -> Vec<Arc<Connection>> {
        if self.closed.load(Ordering::Acquire) {
            return Vec::new();
        }
        self.stop.cancel();
        self.originals.lock().expect("共享监听句柄锁被污染").take();
        if registry
            .get(&self.configured)
            .and_then(Weak::upgrade)
            .is_some_and(|server| std::ptr::eq(Arc::as_ptr(&server), self))
        {
            registry.remove(&self.configured);
        }
        // closed 是描述符已释放的完成状态，不能先发布再执行实际关闭。
        self.closed.store(true, Ordering::Release);
        self.routes
            .lock()
            .expect("共享代理归属锁被污染")
            .values()
            .filter_map(|route| route.connection.upgrade())
            .collect()
    }
}

/// 运行时关闭或任务异常丢弃时也释放入口，不能保留仅有绑定句柄的半可用代理。
struct RunGuard {
    server: Arc<Server>,
    tcp: Option<TcpListener>,
    udp: Option<Arc<UdpSocket>>,
}
impl RunGuard {
    fn close(&mut self, error: Option<&str>, force: bool) -> bool {
        let connections = {
            // 所有描述符在同一锁下释放；异步任务未开始消费或运行时关闭也遵守相同顺序。
            let mut registry = LISTENERS.lock().expect("共享监听目录锁被污染");
            if !force && error.is_none() && self.server.owners.load(Ordering::Acquire) != 0 {
                return false;
            }
            self.tcp.take();
            self.udp.take();
            self.server.shutdown(&mut registry)
        };
        if let Some(error) = error {
            // 观察器可同步读取宿主状态，调用回调时不能持有监听目录或归属表的锁。
            for connection in connections {
                connection.report(None, false, Some(format!("共享代理监听终止：{error}")));
                connection.process.stop.cancel();
            }
        }
        true
    }
}
impl Drop for RunGuard {
    fn drop(&mut self) {
        self.close(Some("代理任务已终止"), true);
    }
}

#[cfg(test)]
#[path = "../../../../../../test/agent/terminal/unit/listeners.rs"]
mod tests;
