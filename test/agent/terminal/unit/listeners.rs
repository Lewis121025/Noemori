use super::*;

fn run_in_separate_process(name: &str) -> bool {
    let module = module_path!().split_once("::").unwrap().1;
    let name = format!("{module}::{name}");
    const MARKER: &str = "NOEMORI_LISTENER_LIFECYCLE_TEST";
    if std::env::var(MARKER).as_deref() == Ok(name.as_str()) {
        return false;
    }
    // 其他 fixture 的原生 spawn 会短暂继承本进程的 socket；绑定必须发生在隔离子进程启动后。
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"])
        .env(MARKER, &name)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "监听生命周期子进程失败：{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

fn address() -> SocketAddr {
    // 固定入口使用临时客户端端口范围之外的地址，避免关闭后被其他并行测试的客户端抢占。
    for _ in 0..100 {
        let bytes = uuid::Uuid::new_v4().into_bytes();
        let port = 10000 + u16::from_ne_bytes([bytes[0], bytes[1]]) % 10000;
        let address = SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
        if let Ok(_tcp) = std::net::TcpListener::bind(address)
            && let Ok(_udp) = std::net::UdpSocket::bind(address)
        {
            return address;
        }
    }
    panic!("无法分配测试专用固定端口")
}

#[test]
fn runtime_shutdown_releases_a_listener_even_if_its_serving_task_was_never_polled() {
    if run_in_separate_process(
        "runtime_shutdown_releases_a_listener_even_if_its_serving_task_was_never_polled",
    ) {
        return;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let entered = runtime.enter();
    let requested = address();
    let owner = acquire(&TerminalProxyListener {
        address: requested,
        allow_non_loopback: false,
    })
    .unwrap();
    drop(entered);
    drop(runtime);
    assert!(owner.server.closed.load(Ordering::Acquire));
    assert!(std::net::TcpListener::bind(requested).is_ok());
    assert!(std::net::UdpSocket::bind(requested).is_ok());
    drop(owner);
}

#[test]
fn runtime_shutdown_releases_udp_even_if_a_control_association_keeps_its_reply_path() {
    if run_in_separate_process(
        "runtime_shutdown_releases_udp_even_if_a_control_association_keeps_its_reply_path",
    ) {
        return;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let requested = address();
    let (owner, connection, lease) = runtime.block_on(async {
        let owner = acquire(&TerminalProxyListener {
            address: requested,
            allow_non_loopback: false,
        })
        .unwrap();
        let connection = Arc::new(Connection {
            policy: super::super::TerminalNetworkPolicy::new(Default::default()).unwrap(),
            process: super::super::ProcessNetwork {
                session: Arc::new(super::super::NetworkSession::default()),
                terminal_id: "terminal".into(),
                call_id: "call".into(),
                command: "unused".into(),
                workdir: std::env::temp_dir(),
                stop: CancellationToken::new(),
                observer: None,
                ingress: Arc::new(IngressRuntime::default()),
            },
            password: "password".into(),
            tasks: TaskTracker::new(),
            udp: owner.server.udp.clone(),
            datagram_flows: Arc::new(Semaphore::new(64)),
        });
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let peer = client.local_addr().unwrap();
        let lease = owner
            .server
            .udp
            .register(peer.ip(), 0, &connection)
            .unwrap();
        client.send_to(&[], requested).await.unwrap();
        // 第二个未指定来源端口的控制关联只能在第一条返回路径已确定后建立。
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if owner.server.udp.register(peer.ip(), 0, &connection).is_ok() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        (owner, connection, lease)
    });
    drop(runtime);
    assert!(owner.server.closed.load(Ordering::Acquire));
    assert!(std::net::TcpListener::bind(requested).is_ok());
    let rebound = std::net::UdpSocket::bind(requested);
    assert!(rebound.is_ok(), "已关闭的入口仍占用 UDP 端口：{rebound:?}");
    drop(lease);
    drop(connection);
    drop(owner);
}

#[tokio::test]
async fn a_new_owner_can_reuse_an_idle_listener_before_shutdown_without_receiving_a_dead_server() {
    if run_in_separate_process(
        "a_new_owner_can_reuse_an_idle_listener_before_shutdown_without_receiving_a_dead_server",
    ) {
        return;
    }
    let requested = address();
    let config = TerminalProxyListener {
        address: requested,
        allow_non_loopback: false,
    };
    let first = acquire(&config).unwrap();
    let server = first.server.clone();
    drop(first);
    let second = acquire(&config).unwrap();
    assert!(Arc::ptr_eq(&server, &second.server));
    tokio::task::yield_now().await;
    assert!(!server.closed.load(Ordering::Acquire));
    drop(second);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !server.closed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let rebound = std::net::TcpListener::bind(requested);
    assert!(rebound.is_ok(), "已关闭的入口仍占用 TCP 端口：{rebound:?}");
    assert!(std::net::UdpSocket::bind(requested).is_ok());
}
