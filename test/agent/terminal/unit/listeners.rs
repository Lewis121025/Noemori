use super::*;

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

#[tokio::test]
async fn a_new_owner_can_reuse_an_idle_listener_before_shutdown_without_receiving_a_dead_server() {
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
