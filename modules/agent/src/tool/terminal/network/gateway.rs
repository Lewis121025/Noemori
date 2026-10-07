use super::{
    TerminalNetworkPolicy,
    connection::{Connection, ProcessNetwork},
    prefix::Prefix,
};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::{io::Write, path::Path, sync::Arc};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite},
    sync::Semaphore,
    task::JoinHandle,
};
use tokio_util::task::TaskTracker;

/// 进程守卫持有原始监听句柄，任务退出不能提前释放允许的端口供其他服务接管。
pub(in crate::tool::terminal) struct Gateway {
    connection: Arc<Connection>,
    task: Option<JoinHandle<Result<(), String>>>,
    endpoints: Endpoints,
    environment: tempfile::TempPath,
    #[cfg(target_os = "linux")]
    configuration: tempfile::TempPath,
    shared: Vec<super::shared::Registration>,
}

enum Endpoints {
    #[cfg(target_os = "macos")]
    Tcp {
        _v4: std::net::TcpListener,
        _v6: std::net::TcpListener,
        udp4: std::net::UdpSocket,
        udp6: std::net::UdpSocket,
        port: u16,
    },
    #[cfg(target_os = "linux")]
    Unix {
        _socket: std::os::unix::net::UnixListener,
        path: PathBuf,
    },
}

impl Gateway {
    pub(in crate::tool::terminal) fn start(
        policy: TerminalNetworkPolicy,
        process: ProcessNetwork,
        directory: &Path,
    ) -> Result<Self, String> {
        let password = uuid::Uuid::new_v4().simple().to_string();
        let tasks = TaskTracker::new();
        let ingress = process.ingress.prepare(policy.config())?;
        let endpoints = Endpoints::bind(directory)?;
        let connection = Arc::new(Connection {
            policy,
            process,
            password,
            tasks,
            udp: Arc::new(super::udp::Hub::new(endpoints.port())),
            datagram_flows: Arc::new(Semaphore::new(64)),
        });
        let shared = ingress
            .into_iter()
            .map(|endpoint| endpoint.register(&connection))
            .collect();
        #[cfg(target_os = "linux")]
        let configuration = {
            let mut file = tempfile::Builder::new()
                .prefix("proxy-relay-")
                .tempfile_in(directory)
                .map_err(|error| error.to_string())?;
            let Endpoints::Unix { path, .. } = &endpoints;
            let config = super::relay_config::RelayConfig {
                gateway: path.clone(),
                password: connection.password.clone(),
            };
            serde_json::to_writer(&mut file, &config).map_err(|error| error.to_string())?;
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o400))
                .map_err(|error| error.to_string())?;
            file.into_temp_path()
        };
        let mut environment = tempfile::Builder::new()
            .prefix("proxy-environment-")
            .tempfile_in(directory)
            .map_err(|error| error.to_string())?;
        for (name, value) in variables(
            &connection.password,
            endpoints.port(),
            connection.policy.config().enable_socks5,
        ) {
            writeln!(environment, "export {name}='{}'", value)
                .map_err(|error| error.to_string())?;
        }
        use std::os::unix::fs::PermissionsExt;
        environment
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o400))
            .map_err(|error| error.to_string())?;
        let accept = endpoints.listener()?;
        #[cfg(target_os = "macos")]
        let datagrams = endpoints.datagrams()?;
        let serving = connection.clone();
        let task = tokio::spawn(async move {
            #[cfg(target_os = "macos")]
            let outcome = tokio::select! {result=accept.run(serving.clone())=>result,result=serving.udp.clone().listen(datagrams[0].clone(),serving.process.stop.clone(),Some(serving.clone()))=>result,result=serving.udp.clone().listen(datagrams[1].clone(),serving.process.stop.clone(),Some(serving.clone()))=>result};
            #[cfg(target_os = "linux")]
            let outcome = accept.run(serving.clone()).await;
            serving.process.stop.cancel();
            serving.tasks.close();
            serving.tasks.wait().await;
            outcome
        });
        Ok(Self {
            connection,
            task: Some(task),
            endpoints,
            environment: environment.into_temp_path(),
            #[cfg(target_os = "linux")]
            configuration,
            shared,
        })
    }
    pub(in crate::tool::terminal) fn environment(&self) -> &Path {
        &self.environment
    }
    pub(in crate::tool::terminal) fn port(&self) -> u16 {
        self.endpoints.port()
    }
    pub(in crate::tool::terminal) fn variables(
        &self,
    ) -> std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString> {
        variables(
            &self.connection.password,
            self.port(),
            self.connection.policy.config().enable_socks5,
        )
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect()
    }
    #[cfg(target_os = "linux")]
    pub(in crate::tool::terminal) fn socket(&self) -> &Path {
        match &self.endpoints {
            Endpoints::Unix { path, .. } => path,
        }
    }
    #[cfg(target_os = "linux")]
    pub(in crate::tool::terminal) fn configuration(&self) -> &Path {
        &self.configuration
    }
    pub(in crate::tool::terminal) fn cancel(&self) {
        self.connection.process.stop.cancel();
    }
    pub(in crate::tool::terminal) async fn close(&mut self) -> Result<(), String> {
        self.cancel();
        self.shared.clear();
        if let Some(task) = self.task.take() {
            task.await
                .map_err(|error| format!("网络代理任务失败：{error}"))??;
        }
        Ok(())
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Endpoints {
    #[cfg(target_os = "macos")]
    fn bind(_directory: &Path) -> Result<Self, String> {
        // Seatbelt 的 localhost 同时包含 IPv4/IPv6；必须占用两个地址，不能留下另一地址的旁路。
        for _ in 0..16 {
            let v4 =
                std::net::TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
            let port = v4.local_addr().map_err(|error| error.to_string())?.port();
            match std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port)) {
                Ok(v6) => {
                    let sockets = std::net::UdpSocket::bind((std::net::Ipv4Addr::LOCALHOST, port))
                        .and_then(|udp4| {
                            std::net::UdpSocket::bind((std::net::Ipv6Addr::LOCALHOST, port))
                                .map(|udp6| (udp4, udp6))
                        });
                    let (udp4, udp6) = match sockets {
                        Ok(sockets) => sockets,
                        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
                        Err(error) => {
                            return Err(format!("UDP 回环代理无法建立，命令未执行：{error}"));
                        }
                    };
                    return Ok(Self::Tcp {
                        _v4: v4,
                        _v6: v6,
                        port,
                        udp4,
                        udp6,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
                Err(error) => return Err(format!("IPv6 回环代理无法建立，命令未执行：{error}")),
            }
        }
        Err("无法预留进程专属的双栈代理端口".into())
    }
    #[cfg(target_os = "linux")]
    fn bind(directory: &Path) -> Result<Self, String> {
        let path = directory.join("network-gateway.sock");
        let socket =
            std::os::unix::net::UnixListener::bind(&path).map_err(|error| error.to_string())?;
        Ok(Self::Unix {
            _socket: socket,
            path,
        })
    }
    fn port(&self) -> u16 {
        match self {
            #[cfg(target_os = "macos")]
            Self::Tcp { port, .. } => *port,
            #[cfg(target_os = "linux")]
            Self::Unix { .. } => 3128,
        }
    }
    fn listener(&self) -> Result<Listener, String> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Tcp { _v4, _v6, .. } => {
                let v4 = _v4.try_clone().map_err(|error| error.to_string())?;
                v4.set_nonblocking(true)
                    .map_err(|error| error.to_string())?;
                let v6 = _v6.try_clone().map_err(|error| error.to_string())?;
                v6.set_nonblocking(true)
                    .map_err(|error| error.to_string())?;
                Ok(Listener::Tcp {
                    v4: tokio::net::TcpListener::from_std(v4).map_err(|error| error.to_string())?,
                    v6: tokio::net::TcpListener::from_std(v6).map_err(|error| error.to_string())?,
                })
            }
            #[cfg(target_os = "linux")]
            Self::Unix { _socket, .. } => {
                let socket = _socket.try_clone().map_err(|error| error.to_string())?;
                socket
                    .set_nonblocking(true)
                    .map_err(|error| error.to_string())?;
                Ok(Listener::Unix(
                    tokio::net::UnixListener::from_std(socket)
                        .map_err(|error| error.to_string())?,
                ))
            }
        }
    }
    #[cfg(target_os = "macos")]
    fn datagrams(&self) -> Result<[Arc<tokio::net::UdpSocket>; 2], String> {
        let Self::Tcp { udp4, udp6, .. } = self;
        let socket = |source: &std::net::UdpSocket| {
            let copy = source.try_clone().map_err(|error| error.to_string())?;
            copy.set_nonblocking(true)
                .map_err(|error| error.to_string())?;
            tokio::net::UdpSocket::from_std(copy)
                .map(Arc::new)
                .map_err(|error| error.to_string())
        };
        Ok([socket(udp4)?, socket(udp6)?])
    }
}

enum Listener {
    #[cfg(target_os = "macos")]
    Tcp {
        v4: tokio::net::TcpListener,
        v6: tokio::net::TcpListener,
    },
    #[cfg(target_os = "linux")]
    Unix(tokio::net::UnixListener),
}

impl Listener {
    async fn run(self, connection: Arc<Connection>) -> Result<(), String> {
        let slots = Arc::new(Semaphore::new(128));
        loop {
            let permit = tokio::select! { biased; _=connection.process.stop.cancelled()=>break, permit=slots.clone().acquire_owned()=>permit.map_err(|error|error.to_string())? };
            match &self {
                #[cfg(target_os = "macos")]
                Self::Tcp { v4, v6 } => {
                    let (socket,peer)=tokio::select! { biased; _=connection.process.stop.cancelled()=>break, result=v4.accept()=>result, result=v6.accept()=>result }.map_err(|error|error.to_string())?;
                    let state = connection.clone();
                    connection.tasks.spawn(async move {
                        let _permit = permit;
                        serve(socket, state, false, peer).await;
                    });
                }
                #[cfg(target_os = "linux")]
                Self::Unix(listener) => {
                    let socket=tokio::select! { biased; _=connection.process.stop.cancelled()=>break, result=listener.accept()=>result }.map_err(|error|error.to_string())?.0;
                    let state = connection.clone();
                    connection.tasks.spawn(async move {
                        let _permit = permit;
                        serve(
                            socket,
                            state,
                            true,
                            std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, 0)),
                        )
                        .await;
                    });
                }
            }
        }
        Ok(())
    }
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    mut socket: S,
    connection: Arc<Connection>,
    gateway: bool,
    peer: std::net::SocketAddr,
) {
    let operation = async {
        let first = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            if gateway {
                let mut password = [0; 32];
                socket
                    .read_exact(&mut password)
                    .await
                    .map_err(|error| error.to_string())?;
                if !connection.authenticated(b"noemori", &password) {
                    return Err("命名空间网关凭据无效".into());
                }
            }
            socket.read_u8().await.map_err(|error| error.to_string())
        })
        .await
        .map_err(|_| "代理握手超时".to_owned())??;
        if first == 5 {
            super::socks::serve(socket, connection.clone(), peer).await
        } else if first == super::frames::RELAY_UDP && gateway {
            let config = connection.policy.config();
            if !config.enable_socks5 || !config.enable_socks5_udp {
                use tokio::io::AsyncWriteExt;
                socket
                    .write_u8(1)
                    .await
                    .map_err(|error| error.to_string())?;
                return Err("宿主已关闭 SOCKS5 UDP，命名空间数据报入口未开放".into());
            }
            #[cfg(target_os = "linux")]
            {
                connection
                    .udp
                    .clone()
                    .relay(socket, connection.clone())
                    .await
            }
            #[cfg(not(target_os = "linux"))]
            {
                Err("此平台不使用命名空间 UDP 转发".into())
            }
        } else {
            super::http::serve(Prefix::new(socket, vec![first]), connection.clone()).await
        }
    };
    tokio::select! {
        biased;
        _=connection.process.stop.cancelled()=>{},
        outcome=operation=>if let Err(error)=outcome { connection.report(None,false,Some(error)); },
    }
}

fn variables(
    password: &str,
    port: u16,
    socks_enabled: bool,
) -> std::collections::BTreeMap<&'static str, String> {
    let http = format!("http://noemori:{password}@127.0.0.1:{port}");
    let all = if socks_enabled {
        format!("socks5h://noemori:{password}@127.0.0.1:{port}")
    } else {
        http.clone()
    };
    [
        ("HTTP_PROXY", http.clone()),
        ("http_proxy", http.clone()),
        ("HTTPS_PROXY", http.clone()),
        ("https_proxy", http),
        ("ALL_PROXY", all.clone()),
        ("all_proxy", all),
        ("NO_PROXY", String::new()),
        ("no_proxy", String::new()),
    ]
    .into()
}
