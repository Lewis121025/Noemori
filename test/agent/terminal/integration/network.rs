use super::*;
use noemori_agent::tool::terminal::{
    TerminalNetworkConfig, TerminalNetworkDecision, TerminalNetworkPolicy, TerminalNetworkRule,
    TerminalUpstreamProxy,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Approver;
#[async_trait::async_trait]
impl noemori_agent::tool::terminal::TerminalApprover for Approver {
    async fn approve(
        &self,
        _request: noemori_agent::tool::terminal::TerminalApprovalRequest,
        _context: ExecutionContext,
    ) -> Result<noemori_agent::tool::terminal::TerminalApprovalDecision, String> {
        Ok(noemori_agent::tool::terminal::TerminalApprovalDecision::AllowOnce)
    }
}

fn managed(workspace: &Path, port: u16) -> ToolRegistry {
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![TerminalNetworkRule {
            pattern: "127.0.0.1".into(),
            protocols: vec![],
            ports: vec![port],
            decision: TerminalNetworkDecision::Allow,
        }],
        ..Default::default()
    })
    .unwrap();
    let tool = TerminalTool::configured(
        workspace,
        "/bin/sh",
        SandboxMode::Restricted(SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        }),
    )
    .unwrap()
    .with_approver(std::sync::Arc::new(Approver));
    let mut tools = ToolRegistry::new();
    tools.register(tool).unwrap();
    tools
}

fn probe(workspace: &Path) {
    std::fs::write(
        workspace.join("network_probe.py"),
        include_str!("../support/network_probe.py"),
    )
    .unwrap();
}

#[tokio::test]
async fn disabled_socks_protocols_never_contact_targets_and_http_remains_usable() {
    for (socks, udp) in [(false, true), (true, false), (false, false)] {
        let workspace = tempfile::tempdir().unwrap();
        probe(workspace.path());
        let (origin, port) = server().await;
        let datagrams = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let datagram_port = datagrams.local_addr().unwrap().port();
        let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
            rules: vec![TerminalNetworkRule {
                pattern: "127.0.0.1".into(),
                protocols: vec![],
                ports: vec![port, datagram_port],
                decision: TerminalNetworkDecision::Allow,
            }],
            enable_socks5: socks,
            enable_socks5_udp: udp,
            ..Default::default()
        })
        .unwrap();
        let tool = TerminalTool::configured(
            workspace.path(),
            "/bin/sh",
            SandboxMode::Restricted(SandboxConfig {
                network: NetworkAccess::Managed(policy),
                ..Default::default()
            }),
        )
        .unwrap();
        let mut tools = ToolRegistry::new();
        tools.register(tool).unwrap();
        let session = AgentSession::new();
        let mode = if socks { "udp" } else { "socks" };
        let target_port = if socks { datagram_port } else { port };
        let denied = call(&tools, &session, json!({"action":"exec","cmd":format!("python3 network_probe.py {mode} {target_port} 00ff01028003"),"yield_time_ms":10000})).await;
        assert_ne!(denied.output["exit_code"], 0, "{denied:?}");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), origin.accept())
                .await
                .is_err()
        );
        let mut bytes = [0; 64];
        assert!(datagrams.try_recv(&mut bytes).is_err());
        let command = format!(
            "python3 -c 'import os,urllib.parse;print(urllib.parse.urlsplit(os.environ[\"ALL_PROXY\"]).scheme)'; curl --silent --show-error --fail --max-time 3 http://127.0.0.1:{port}/"
        );
        let response = async {
            let (mut peer, _) = origin.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(peer.read_u8().await.unwrap());
            }
            peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                call(
                    &tools,
                    &session,
                    json!({"action":"exec","cmd":command,"yield_time_ms":10000})
                ),
                response
            )
        })
        .await
        .unwrap();
        assert_eq!(result.output["exit_code"], 0, "{result:?}");
        assert_eq!(
            result.output["output"],
            if socks { "socks5h\nok" } else { "http\nok" }
        );
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn http_upstream_never_falls_back_to_direct_udp() {
    let workspace = tempfile::tempdir().unwrap();
    probe(workspace.path());
    let (upstream, proxy_port) = server().await;
    let target = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = target.local_addr().unwrap().port();
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![TerminalNetworkRule {
            pattern: "127.0.0.1".into(),
            protocols: vec![],
            ports: vec![port],
            decision: TerminalNetworkDecision::Allow,
        }],
        upstream_proxy: Some(
            TerminalUpstreamProxy::new(&format!("http://127.0.0.1:{proxy_port}")).unwrap(),
        ),
        ..Default::default()
    })
    .unwrap();
    let tool = TerminalTool::configured(
        workspace.path(),
        "/bin/sh",
        SandboxMode::Restricted(SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        }),
    )
    .unwrap();
    let mut tools = ToolRegistry::new();
    tools.register(tool).unwrap();
    let session = AgentSession::new();
    let result = call(
        &tools,
        &session,
        json!({"action":"exec","cmd":format!("python3 network_probe.py udp-denied {port} 00ff01028003"),"yield_time_ms":10000}),
    )
    .await;
    assert_eq!(result.output["exit_code"], 0, "{result:?}");
    assert_eq!(result.output["output"], "udp-denied\n");
    let mut packet = [0; 64];
    assert!(
        target.try_recv_from(&mut packet).is_err(),
        "上游配置被 UDP 直连绕过"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), upstream.accept())
            .await
            .is_err()
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn socks_upstream_udp_routes_real_sandbox_packets_and_releases_the_control_connection() {
    let workspace = tempfile::tempdir().unwrap();
    probe(workspace.path());
    let (upstream, proxy_port) = server().await;
    let target = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = target.local_addr().unwrap().port();
    let relay = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let relay_port = relay.local_addr().unwrap().port();
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![TerminalNetworkRule {
            pattern: "127.0.0.1".into(),
            protocols: vec![],
            ports: vec![port],
            decision: TerminalNetworkDecision::Allow,
        }],
        upstream_proxy: Some(
            TerminalUpstreamProxy::new(&format!("socks5://127.0.0.1:{proxy_port}")).unwrap(),
        ),
        ..Default::default()
    })
    .unwrap();
    let tool = TerminalTool::configured(
        workspace.path(),
        "/bin/sh",
        SandboxMode::Restricted(SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        }),
    )
    .unwrap();
    let mut tools = ToolRegistry::new();
    tools.register(tool).unwrap();
    let session = AgentSession::new();
    let route = async {
        let (mut control, _) = upstream.accept().await.unwrap();
        let mut greeting = [0; 3];
        control.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 1, 0]);
        control.write_all(&[5, 0]).await.unwrap();
        let mut associate = [0; 10];
        control.read_exact(&mut associate).await.unwrap();
        assert_eq!(&associate[..4], &[5, 3, 0, 1]);
        let mut reply = vec![5, 0, 0, 1, 127, 0, 0, 1];
        reply.extend(relay_port.to_be_bytes());
        control.write_all(&reply).await.unwrap();
        let mut packet = [0; 64];
        let (count, source) = relay.recv_from(&mut packet).await.unwrap();
        assert_eq!(&packet[..8], &[0, 0, 0, 1, 127, 0, 0, 1]);
        assert_eq!(&packet[8..10], &port.to_be_bytes());
        assert_eq!(&packet[10..count], &[0, 255, 1, 2, 128, 3]);
        relay.send_to(&packet[..count], source).await.unwrap();
        assert!(control.read_u8().await.is_err());
        assert!(relay.try_recv_from(&mut packet).is_err());
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            call(&tools, &session, json!({"action":"exec","cmd":format!("python3 network_probe.py udp {port} 00ff01028003"),"yield_time_ms":10000})),
            route,
        )
    }).await.unwrap();
    assert_eq!(result.output["exit_code"], 0, "{result:?}");
    assert_eq!(result.output["output"], "udp\n");
    let mut packet = [0; 64];
    assert!(
        target.try_recv_from(&mut packet).is_err(),
        "业务目标不应收到直连数据报"
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn upstream_connect_is_authenticated_and_target_rules_are_checked_before_the_proxy_is_contacted()
 {
    let workspace = tempfile::tempdir().unwrap();
    probe(workspace.path());
    let (upstream, proxy_port) = server().await;
    let (_target, target_port) = server().await;
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![TerminalNetworkRule {
            pattern: "127.0.0.1".into(),
            protocols: vec![],
            ports: vec![target_port],
            decision: TerminalNetworkDecision::Allow,
        }],
        upstream_proxy: Some(
            TerminalUpstreamProxy::new(&format!(
                "http://user:upstream-secret@127.0.0.1:{proxy_port}"
            ))
            .unwrap(),
        ),
        ..Default::default()
    })
    .unwrap();
    let tool = TerminalTool::configured(
        workspace.path(),
        "/bin/sh",
        SandboxMode::Restricted(SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        }),
    )
    .unwrap();
    let mut tools = ToolRegistry::new();
    tools.register(tool).unwrap();
    let session = AgentSession::new();
    let request = async {
        let (mut peer, _) = upstream.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(peer.read_u8().await.unwrap());
        }
        let header = String::from_utf8(header).unwrap();
        assert!(
            header.starts_with(&format!("CONNECT 127.0.0.1:{target_port} HTTP/1.1\r\n")),
            "{header}"
        );
        assert!(header.contains("Proxy-Authorization: Basic dXNlcjp1cHN0cmVhbS1zZWNyZXQ="));
        peer.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        let mut data = [0; 6];
        peer.read_exact(&mut data).await.unwrap();
        assert_eq!(data, [0, 255, 1, 2, 128, 3]);
        peer.write_all(&data).await.unwrap();
    };
    let (result,())=tokio::time::timeout(Duration::from_secs(10),async {tokio::join!(call(&tools,&session,json!({"action":"exec","cmd":format!("python3 network_probe.py connect {target_port} 00ff01028003"),"yield_time_ms":10000})),request)}).await.unwrap();
    assert_eq!(result.output["exit_code"], 0, "{result:?}");
    assert_eq!(result.output["output"], "connect\n");
    let denied=call(&tools,&session,json!({"action":"exec","cmd":"curl --silent --show-error --fail --max-time 2 http://127.0.0.1:1/"})).await;
    assert_ne!(denied.output["exit_code"], 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), upstream.accept())
            .await
            .is_err()
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn socks_udp_associations_forward_binary_datagrams_without_opening_direct_network_access() {
    let workspace = tempfile::tempdir().unwrap();
    probe(workspace.path());
    let echo = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = echo.local_addr().unwrap().port();
    let blocked = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let blocked_port = blocked.local_addr().unwrap().port();
    let tools = managed(workspace.path(), port);
    let session = AgentSession::new();
    let response = async {
        let mut payload = [0; 64];
        let (count, peer) = echo.recv_from(&mut payload).await.unwrap();
        assert_eq!(&payload[..count], &[0, 255, 1, 2, 128, 3]);
        echo.send_to(&payload[..count], peer).await.unwrap();
    };
    let command = format!("python3 network_probe.py udp {port} 00ff01028003 {blocked_port}");
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            call(
                &tools,
                &session,
                json!({"action":"exec","cmd":command,"yield_time_ms":10000})
            ),
            response
        )
    })
    .await
    .unwrap();
    assert_eq!(result.output["exit_code"], 0, "{result:?}");
    assert_eq!(result.output["output"], "udp\n");
    let mut bytes = [0; 64];
    assert!(echo.try_recv_from(&mut bytes).is_err());
    assert!(blocked.try_recv_from(&mut bytes).is_err());
    session.close().await.unwrap();
}

async fn server() -> (tokio::net::TcpListener, u16) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

#[tokio::test]
async fn managed_http_network_is_enforced_by_the_system_and_cannot_be_widened_by_permission_approval()
 {
    let workspace = tempfile::tempdir().unwrap();
    let (allowed, port) = server().await;
    let (blocked, blocked_port) = server().await;
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![TerminalNetworkRule {
            pattern: "127.0.0.1".into(),
            protocols: vec![],
            ports: vec![port],
            decision: TerminalNetworkDecision::Allow,
        }],
        ..Default::default()
    })
    .unwrap();
    let tool = TerminalTool::configured(
        workspace.path(),
        "/bin/sh",
        SandboxMode::Restricted(SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        }),
    )
    .unwrap()
    .with_approver(std::sync::Arc::new(Approver));
    let mut tools = ToolRegistry::new();
    tools.register(tool).unwrap();
    let session = AgentSession::new();
    let response = async {
        let (mut stream, _) = allowed.accept().await.unwrap();
        let mut data = vec![0; 4096];
        let count = stream.read(&mut data).await.unwrap();
        let request = String::from_utf8_lossy(&data[..count]);
        assert!(request.starts_with("GET /allowed HTTP/1.1"), "{request}");
        assert!(!request.to_ascii_lowercase().contains("proxy-authorization"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nallowed")
            .await
            .unwrap();
    };
    let command =
        format!("curl --silent --show-error --fail --max-time 5 http://127.0.0.1:{port}/allowed");
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            call(
                &tools,
                &session,
                json!({"action":"exec", "cmd":command, "yield_time_ms":10000})
            ),
            response
        )
    })
    .await
    .expect("已允许目标必须在预算内完成代理请求");
    assert!(!result.is_error, "{result:?}");
    assert_eq!(result.output["exit_code"], 0, "{result:?}");
    assert_eq!(result.output["output"], "allowed");
    for command in [
        format!(
            "curl --silent --show-error --fail --max-time 2 http://127.0.0.1:{blocked_port}/blocked"
        ),
        format!(
            "curl --silent --show-error --fail --noproxy '*' --max-time 2 http://127.0.0.1:{port}/direct"
        ),
    ] {
        let denied = call(
            &tools,
            &session,
            json!({"action":"exec", "cmd":command, "yield_time_ms":5000,"permission_request":{"reason":"network access must remain scoped", "network":true}}),
        )
        .await;
        assert_ne!(denied.output["exit_code"], 0, "{denied:?}");
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), blocked.accept())
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), allowed.accept())
            .await
            .is_err()
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn socks_and_connect_tunnels_preserve_binary_data_and_websocket_upgrades_preserve_buffered_bytes()
 {
    for mode in ["socks", "connect", "websocket"] {
        let workspace = tempfile::tempdir().unwrap();
        probe(workspace.path());
        let (listener, port) = server().await;
        let tools = managed(workspace.path(), port);
        let session = AgentSession::new();
        let server = async {
            let (mut peer, _) = listener.accept().await.unwrap();
            if mode == "websocket" {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(peer.read_u8().await.unwrap());
                }
                assert!(
                    !String::from_utf8_lossy(&request)
                        .to_ascii_lowercase()
                        .contains("proxy-authorization")
                );
                peer.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nearly").await.unwrap();
                let mut bytes = [0; 5];
                peer.read_exact(&mut bytes).await.unwrap();
                assert_eq!(&bytes, b"later");
                peer.write_all(&bytes).await.unwrap();
            } else {
                let mut payload = [0; 6];
                peer.read_exact(&mut payload).await.unwrap();
                assert_eq!(payload, [0, 255, 1, 2, 128, 3]);
                peer.write_all(&payload).await.unwrap();
            }
        };
        let command = format!("python3 network_probe.py {mode} {port} 00ff01028003");
        let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                call(
                    &tools,
                    &session,
                    json!({"action":"exec","cmd":command,"yield_time_ms":10000})
                ),
                server
            )
        })
        .await
        .unwrap();
        assert!(!result.is_error, "{mode}: {result:?}");
        assert_eq!(result.output["exit_code"], 0, "{mode}: {result:?}");
        assert_eq!(result.output["output"], format!("{mode}\n"));
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn http_connection_reuse_checks_each_target_and_kernel_network_limits_block_unix_and_ip_bypasses()
 {
    let workspace = tempfile::tempdir().unwrap();
    probe(workspace.path());
    let (listener, port) = server().await;
    let (blocked, blocked_port) = server().await;
    let tools = managed(workspace.path(), port);
    let session = AgentSession::new();
    let response = async {
        let (mut peer, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(peer.read_u8().await.unwrap());
        }
        peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nallowed")
            .await
            .unwrap();
    };
    let command = format!("python3 network_probe.py reuse {port} {blocked_port}");
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            call(
                &tools,
                &session,
                json!({"action":"exec","cmd":command,"yield_time_ms":10000})
            ),
            response
        )
    })
    .await
    .unwrap();
    assert_eq!(result.output["exit_code"], 0, "{result:?}");
    assert_eq!(result.output["output"], "reuse\n");
    let unix = std::os::unix::net::UnixListener::bind(workspace.path().join("host.sock")).unwrap();
    unix.set_nonblocking(true).unwrap();
    let datagram =
        std::os::unix::net::UnixDatagram::bind(workspace.path().join("host-datagram.sock"))
            .unwrap();
    datagram.set_nonblocking(true).unwrap();
    let result=call(&tools,&session,json!({"action":"exec","cmd":format!("python3 network_probe.py bypass {blocked_port}"),"yield_time_ms":10000})).await;
    assert_eq!(result.output["exit_code"], 0, "{result:?}");
    assert!(unix.accept().is_err());
    let mut byte = [0];
    assert!(datagram.recv(&mut byte).is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), blocked.accept())
            .await
            .is_err()
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn managed_snapshots_restore_fresh_proxy_credentials_after_user_profiles() {
    for shell in ["/bin/bash", "/bin/zsh"] {
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let file = if shell.ends_with("zsh") {
            ".zshrc"
        } else {
            ".bash_profile"
        };
        std::fs::write(home.path().join(file),"export HTTP_PROXY=http://wrong.example:1\nreadonly HTTPS_PROXY=http://wrong.example:1\nexport NO_PROXY='*'\n").unwrap();
        let (listener, port) = server().await;
        let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
            rules: vec![TerminalNetworkRule {
                pattern: "127.0.0.1".into(),
                protocols: vec![],
                ports: vec![port],
                decision: TerminalNetworkDecision::Allow,
            }],
            ..Default::default()
        })
        .unwrap();
        let tool = TerminalTool::configured(
            workspace.path(),
            shell,
            SandboxMode::Restricted(SandboxConfig {
                network: NetworkAccess::Managed(policy),
                readable_paths: vec![home.path().to_owned()],
                ..Default::default()
            }),
        )
        .unwrap();
        let tool = tool
            .capture_shell_snapshot(
                home.path(),
                ExecutionContext::new(
                    noemori_agent::CancellationToken::new(),
                    Duration::from_secs(10),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let mut tools = ToolRegistry::new();
        tools.register(tool).unwrap();
        let session = AgentSession::new();
        let response = async {
            let (mut peer, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(peer.read_u8().await.unwrap());
            }
            peer.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nallowed",
            )
            .await
            .unwrap();
        };
        let command = format!(
            "curl --silent --show-error --fail --max-time 5 http://127.0.0.1:{port}/allowed"
        );
        let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                call(
                    &tools,
                    &session,
                    json!({"action":"exec","cmd":command,"yield_time_ms":10000})
                ),
                response
            )
        })
        .await
        .unwrap();
        assert_eq!(result.output["exit_code"], 0, "{shell}: {result:?}");
        assert_eq!(result.output["output"], "allowed");
        session.close().await.unwrap();
    }
}
