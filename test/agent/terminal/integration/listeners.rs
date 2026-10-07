use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use noemori_agent::tool::terminal::{
    TerminalNetworkConfig, TerminalNetworkDecision, TerminalNetworkPolicy, TerminalNetworkRule,
    TerminalProxyListener,
};
use std::net::SocketAddr;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

fn available_address() -> SocketAddr {
    let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = tcp.local_addr().unwrap();
    let _udp = std::net::UdpSocket::bind(address).unwrap();
    address
}

fn configured(workspace: &Path, address: SocketAddr, port: u16) -> (TerminalTool, ToolRegistry) {
    let listener = TerminalProxyListener {
        address,
        allow_non_loopback: false,
    };
    configuration(
        workspace,
        TerminalNetworkConfig {
            rules: vec![TerminalNetworkRule {
                pattern: "127.0.0.1".into(),
                protocols: vec![],
                ports: vec![port],
                decision: TerminalNetworkDecision::Allow,
            }],
            http_listener: Some(listener.clone()),
            socks_listener: Some(listener),
            ..Default::default()
        },
    )
}

fn configuration(workspace: &Path, config: TerminalNetworkConfig) -> (TerminalTool, ToolRegistry) {
    let policy = TerminalNetworkPolicy::new(config).unwrap();
    let tool = TerminalTool::configured(
        workspace,
        "/bin/sh",
        SandboxMode::Restricted(SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        }),
    )
    .unwrap();
    let mut registry = ToolRegistry::new();
    registry.register(tool.clone()).unwrap();
    (tool, registry)
}

async fn socks(address: SocketAddr, password: &str) -> TcpStream {
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket.write_all(&[5, 1, 2]).await.unwrap();
    let mut reply = [0; 2];
    socket.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply, [5, 2]);
    let mut auth = vec![1, 7];
    auth.extend(b"noemori");
    auth.push(u8::try_from(password.len()).unwrap());
    auth.extend(password.as_bytes());
    socket.write_all(&auth).await.unwrap();
    socket.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply, [1, 0]);
    socket
}

async fn command(socket: &mut TcpStream, operation: u8, target: SocketAddr) -> Vec<u8> {
    let mut bytes = vec![5, operation, 0];
    match target.ip() {
        std::net::IpAddr::V4(ip) => {
            bytes.push(1);
            bytes.extend(ip.octets());
        }
        std::net::IpAddr::V6(ip) => {
            bytes.push(4);
            bytes.extend(ip.octets());
        }
    }
    bytes.extend(target.port().to_be_bytes());
    socket.write_all(&bytes).await.unwrap();
    let mut header = [0; 4];
    socket.read_exact(&mut header).await.unwrap();
    let size = if header[3] == 1 { 6 } else { 18 };
    let mut response = header.to_vec();
    response.resize(size + 4, 0);
    socket.read_exact(&mut response[4..]).await.unwrap();
    response
}

fn datagram(target: SocketAddr, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0, 0, 0];
    match target.ip() {
        std::net::IpAddr::V4(ip) => {
            bytes.push(1);
            bytes.extend(ip.octets());
        }
        std::net::IpAddr::V6(ip) => {
            bytes.push(4);
            bytes.extend(ip.octets());
        }
    }
    bytes.extend(target.port().to_be_bytes());
    bytes.extend(payload);
    bytes
}

#[tokio::test]
async fn shared_socks_udp_has_unique_source_ownership_and_advertises_the_public_reply_port() {
    let root = tempfile::tempdir().unwrap();
    let address = available_address();
    let first_origin = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let second_origin = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let first_target = first_origin.local_addr().unwrap();
    let second_target = second_origin.local_addr().unwrap();
    let (first_tool, first) = configured(root.path(), address, first_target.port());
    let (second_tool, second) = configured(root.path(), address, second_target.port());
    let first_session = AgentSession::new();
    let second_session = AgentSession::new();
    let (_, first_password) = launch(&first, &first_session).await;
    let (_, second_password) = launch(&second, &second_session).await;
    let first_udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let second_udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut first_control = socks(address, &first_password).await;
    let associated = command(&mut first_control, 3, first_udp.local_addr().unwrap()).await;
    assert_eq!(&associated[..4], &[5, 0, 0, 1]);
    assert_eq!(&associated[8..10], &address.port().to_be_bytes());
    let mut duplicate = socks(address, &second_password).await;
    assert_eq!(
        command(&mut duplicate, 3, first_udp.local_addr().unwrap()).await[1],
        2
    );
    let mut second_control = socks(address, &second_password).await;
    assert_eq!(
        command(&mut second_control, 3, second_udp.local_addr().unwrap()).await[1],
        0
    );
    let payload = [0, 255, 1, 2, 128, 3];
    let unauthorized = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    unauthorized
        .send_to(&datagram(first_target, &payload), address)
        .await
        .unwrap();
    first_udp
        .send_to(&datagram(second_target, &payload), address)
        .await
        .unwrap();
    let mut bytes = [0; 64];
    assert!(
        tokio::time::timeout(Duration::from_millis(150), second_origin.recv(&mut bytes))
            .await
            .is_err()
    );
    let echo = async {
        let (count, peer) = first_origin.recv_from(&mut bytes).await.unwrap();
        assert_eq!(&bytes[..count], &payload);
        first_origin.send_to(&bytes[..count], peer).await.unwrap();
    };
    let receive = async {
        let packet = datagram(first_target, &payload);
        first_udp.send_to(&packet, address).await.unwrap();
        let mut response = [0; 64];
        let (count, peer) = first_udp.recv_from(&mut response).await.unwrap();
        assert_eq!(peer, address);
        assert_eq!(&response[..count], packet);
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(echo, receive)
    })
    .await
    .unwrap();
    drop(first_control);
    tokio::time::sleep(Duration::from_millis(50)).await;
    first_udp
        .send_to(&datagram(first_target, &payload), address)
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(150), first_origin.recv(&mut bytes))
            .await
            .is_err()
    );
    let echo = async {
        let (count, peer) = second_origin.recv_from(&mut bytes).await.unwrap();
        assert_eq!(&bytes[..count], &payload);
        second_origin.send_to(&bytes[..count], peer).await.unwrap();
    };
    let receive = async {
        let packet = datagram(second_target, &payload);
        second_udp.send_to(&packet, address).await.unwrap();
        let mut response = [0; 64];
        let count = second_udp.recv(&mut response).await.unwrap();
        assert_eq!(&response[..count], packet);
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(echo, receive)
    })
    .await
    .unwrap();
    drop(second_control);
    drop(duplicate);
    first_session.close().await.unwrap();
    second_session.close().await.unwrap();
    drop(first);
    drop(second);
    drop(first_tool);
    drop(second_tool);
}

#[tokio::test]
async fn separate_http_and_socks_listeners_do_not_accept_credentials_for_the_other_protocol() {
    let root = tempfile::tempdir().unwrap();
    let http = available_address();
    let socks_address = available_address();
    let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = origin.local_addr().unwrap();
    let (tool, registry) = configuration(
        root.path(),
        TerminalNetworkConfig {
            rules: vec![TerminalNetworkRule {
                pattern: "127.0.0.1".into(),
                protocols: vec![],
                ports: vec![target.port()],
                decision: TerminalNetworkDecision::Allow,
            }],
            http_listener: Some(TerminalProxyListener {
                address: http,
                allow_non_loopback: false,
            }),
            socks_listener: Some(TerminalProxyListener {
                address: socks_address,
                allow_non_loopback: false,
            }),
            ..Default::default()
        },
    );
    let session = AgentSession::new();
    let (_, password) = launch(&registry, &session).await;
    assert_eq!(tool.proxy_listeners().len(), 2);
    assert!(
        request(socks_address, &password, target.port())
            .await
            .starts_with("HTTP/1.1 407")
    );
    let mut wrong = TcpStream::connect(http).await.unwrap();
    wrong.write_all(&[5, 1, 2]).await.unwrap();
    let mut denied = [0; 2];
    wrong.read_exact(&mut denied).await.unwrap();
    assert_eq!(denied, [5, 255]);
    let mut control = socks(socks_address, &password).await;
    let echo = async {
        let (mut peer, _) = origin.accept().await.unwrap();
        let mut bytes = [0; 6];
        peer.read_exact(&mut bytes).await.unwrap();
        assert_eq!(bytes, [0, 255, 1, 2, 128, 3]);
        peer.write_all(&bytes).await.unwrap();
    };
    let receive = async {
        assert_eq!(command(&mut control, 1, target).await[1], 0);
        control.write_all(&[0, 255, 1, 2, 128, 3]).await.unwrap();
        let mut bytes = [0; 6];
        control.read_exact(&mut bytes).await.unwrap();
        assert_eq!(bytes, [0, 255, 1, 2, 128, 3]);
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(echo, receive)
    })
    .await
    .unwrap();
    drop(control);
    session.close().await.unwrap();
}

#[tokio::test]
async fn failure_to_bind_the_second_listener_rolls_back_the_first_and_does_not_execute_the_command()
{
    let root = tempfile::tempdir().unwrap();
    let mut addresses = [available_address(), available_address()];
    addresses.sort();
    let first = addresses[0];
    let second = addresses[1];
    let occupied = std::net::TcpListener::bind(second).unwrap();
    let (tool, registry) = configuration(
        root.path(),
        TerminalNetworkConfig {
            http_listener: Some(TerminalProxyListener {
                address: first,
                allow_non_loopback: false,
            }),
            socks_listener: Some(TerminalProxyListener {
                address: second,
                allow_non_loopback: false,
            }),
            ..Default::default()
        },
    );
    let session = AgentSession::new();
    let failed = call(
        &registry,
        &session,
        json!({"action":"exec","cmd":"touch should-not-run","yield_time_ms":1000}),
    )
    .await;
    assert!(failed.is_error);
    assert!(!root.path().join("should-not-run").exists());
    assert!(tool.proxy_listeners().is_empty());
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if std::net::TcpListener::bind(first).is_ok()
                && std::net::UdpSocket::bind(first).is_ok()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(occupied);
    launch(&registry, &session).await;
    assert_eq!(tool.proxy_listeners().len(), 2);
    session.close().await.unwrap();
}

#[tokio::test]
async fn explicitly_enabled_wildcard_and_ipv6_listeners_publish_their_actual_allocated_port() {
    for configured in ["0.0.0.0:0", "[::1]:0"] {
        let root = tempfile::tempdir().unwrap();
        let origin_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = origin_listener.local_addr().unwrap().port();
        let (tool, registry) = configuration(
            root.path(),
            TerminalNetworkConfig {
                rules: vec![TerminalNetworkRule {
                    pattern: "127.0.0.1".into(),
                    protocols: vec![],
                    ports: vec![port],
                    decision: TerminalNetworkDecision::Allow,
                }],
                http_listener: Some(TerminalProxyListener {
                    address: configured.parse().unwrap(),
                    allow_non_loopback: true,
                }),
                ..Default::default()
            },
        );
        let session = AgentSession::new();
        let (_, password) = launch(&registry, &session).await;
        let info = tool.proxy_listeners();
        assert_eq!(info.len(), 1);
        assert_ne!(info[0].bound_address.port(), 0);
        let mut address = info[0].bound_address;
        if address.ip().is_unspecified() {
            address.set_ip(std::net::Ipv4Addr::LOCALHOST.into());
        }
        let (response, ()) = tokio::join!(
            request(address, &password, port),
            origin(&origin_listener, "allocated")
        );
        assert!(response.ends_with("allocated"));
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn shared_connect_and_websocket_upgrades_preserve_prefetched_binary_bytes() {
    let root = tempfile::tempdir().unwrap();
    let address = available_address();
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = destination.local_addr().unwrap().port();
    let (_tool, registry) = configured(root.path(), address, port);
    let session = AgentSession::new();
    let (_, password) = launch(&registry, &session).await;
    for websocket in [false, true] {
        let mut client = TcpStream::connect(address).await.unwrap();
        let auth = STANDARD.encode(format!("noemori:{password}"));
        let header = if websocket {
            format!(
                "GET http://127.0.0.1:{port}/ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nProxy-Authorization: Basic {auth}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
            )
        } else {
            format!(
                "CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nProxy-Authorization: Basic {auth}\r\n\r\n"
            )
        };
        let mut sent = header.into_bytes();
        sent.extend([0, 255, 1, 2, 128, 3]);
        client.write_all(&sent).await.unwrap();
        let remote = async {
            let (mut socket, _) = destination.accept().await.unwrap();
            if websocket {
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    bytes.push(socket.read_u8().await.unwrap());
                }
                socket.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
            }
            let mut payload = [0; 6];
            socket.read_exact(&mut payload).await.unwrap();
            assert_eq!(payload, [0, 255, 1, 2, 128, 3]);
            socket.write_all(&payload).await.unwrap();
        };
        let receive = async {
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(client.read_u8().await.unwrap());
            }
            let expected = if websocket {
                b"HTTP/1.1 101"
            } else {
                b"HTTP/1.1 200"
            };
            assert!(header.starts_with(expected));
            let mut payload = [0; 6];
            client.read_exact(&mut payload).await.unwrap();
            assert_eq!(payload, [0, 255, 1, 2, 128, 3]);
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(remote, receive)
        })
        .await
        .unwrap();
    }
    session.close().await.unwrap();
}

async fn launch(registry: &ToolRegistry, session: &AgentSession) -> (String, String) {
    let result = call(registry, session, json!({"action":"exec","cmd":"printf '%s\\n' \"$HTTP_PROXY\"; sleep 30","yield_time_ms":100})).await;
    assert!(!result.is_error, "共享入口启动失败：{:?}", result.output);
    let value = result.output;
    let value = ready(registry, session, value, |text| text.ends_with('\n')).await;
    let url = url::Url::parse(value["output"].as_str().unwrap().trim()).unwrap();
    (
        value["session_id"].as_str().unwrap().into(),
        url.password().unwrap().into(),
    )
}

async fn request(address: SocketAddr, password: &str, target: u16) -> String {
    let mut socket = TcpStream::connect(address).await.unwrap();
    let authorization = STANDARD.encode(format!("noemori:{password}"));
    socket.write_all(format!("GET http://127.0.0.1:{target}/ HTTP/1.1\r\nHost: 127.0.0.1:{target}\r\nProxy-Authorization: Basic {authorization}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(3), socket.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    response
}

async fn origin(listener: &TcpListener, value: &str) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        header.push(socket.read_u8().await.unwrap());
    }
    assert!(
        !String::from_utf8(header)
            .unwrap()
            .to_ascii_lowercase()
            .contains("proxy-authorization")
    );
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{value}",
                value.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn shared_listener_routes_credentials_to_their_process_policy_and_revokes_only_the_stopped_process()
 {
    let root = tempfile::tempdir().unwrap();
    let address = available_address();
    let first_origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_port = first_origin.local_addr().unwrap().port();
    let second_port = second_origin.local_addr().unwrap().port();
    let (first_tool, first) = configured(root.path(), address, first_port);
    let (second_tool, second) = configured(root.path(), address, second_port);
    assert!(first_tool.proxy_listeners().is_empty());
    let first_session = AgentSession::new();
    let second_session = AgentSession::new();
    let (first_id, first_password) = launch(&first, &first_session).await;
    let (_, second_password) = launch(&second, &second_session).await;
    let status = first_tool.proxy_listeners();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].bound_address, address);
    assert_eq!(status[0].active_terminals, 2);
    let (response, ()) = tokio::join!(
        request(address, &first_password, first_port),
        origin(&first_origin, "first")
    );
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.ends_with("first"));
    assert!(
        request(address, &first_password, second_port)
            .await
            .starts_with("HTTP/1.1 403")
    );
    assert!(
        request(address, "invalid", second_port)
            .await
            .starts_with("HTTP/1.1 407")
    );
    let (response, ()) = tokio::join!(
        request(address, &second_password, second_port),
        origin(&second_origin, "second")
    );
    assert!(response.ends_with("second"));
    first_tool.request_stop(&first_session, &first_id).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut subscription = first_tool.subscribe(&first_session, &first_id, 0).unwrap();
        while let Some(event) = subscription.recv().await.unwrap() {
            if matches!(
                event,
                noemori_agent::tool::terminal::TerminalEvent::Exited { .. }
            ) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(
        request(address, &first_password, first_port)
            .await
            .starts_with("HTTP/1.1 407")
    );
    let (response, ()) = tokio::join!(
        request(address, &second_password, second_port),
        origin(&second_origin, "still-running")
    );
    assert!(response.ends_with("still-running"));
    first_session.close().await.unwrap();
    second_session.close().await.unwrap();
    assert_eq!(first_tool.proxy_listeners()[0].active_terminals, 0);
    drop(first);
    drop(second);
    drop(first_tool);
    drop(second_tool);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if std::net::TcpListener::bind(address).is_ok()
                && std::net::UdpSocket::bind(address).is_ok()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
