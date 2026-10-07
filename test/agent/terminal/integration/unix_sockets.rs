use super::*;
use noemori_agent::tool::terminal::{
    TerminalNetworkConfig, TerminalNetworkDecision, TerminalNetworkPolicy,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
};

#[tokio::test]
async fn unix_socket_allowlist_works_without_opening_other_sockets_or_ordinary_files() {
    verify(false).await;
}

#[tokio::test]
async fn explicit_all_unix_access_still_honors_exact_denials_and_file_boundaries() {
    verify(true).await;
}

#[tokio::test]
async fn unix_datagram_clients_can_bind_private_reply_paths_without_opening_other_destinations() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let allowed_path = root.path().join("datagrams.sock");
    let blocked_path = root.path().join("blocked-datagrams.sock");
    let native = std::os::unix::net::UnixDatagram::bind(&allowed_path).unwrap();
    native.set_nonblocking(true).unwrap();
    let allowed = tokio::io::unix::AsyncFd::new(native).unwrap();
    let blocked = tokio::net::UnixDatagram::bind(&blocked_path).unwrap();
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        unix_sockets: [
            (allowed_path.clone(), TerminalNetworkDecision::Allow),
            (blocked_path.clone(), TerminalNetworkDecision::Deny),
        ]
        .into(),
        ..Default::default()
    })
    .unwrap();
    let registry = tools(
        &workspace,
        SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        },
    );
    std::fs::write(
        workspace.join("probe.py"),
        include_str!("../support/unix_datagram_probe.py"),
    )
    .unwrap();
    let command = format!(
        "python3 probe.py {} {}",
        shlex::try_quote(allowed_path.to_str().unwrap()).unwrap(),
        shlex::try_quote(blocked_path.to_str().unwrap()).unwrap(),
    );
    let session = AgentSession::new();
    let response = async {
        use nix::sys::socket::{MsgFlags, UnixAddr, recvfrom, sendto};
        use std::os::fd::AsRawFd;
        let mut bytes = [0; 64];
        // 保留 BSD sockaddr 的实际长度，标准库会无条件剔除不存在的结尾 NUL。
        let (count, peer) = allowed
            .async_io(tokio::io::Interest::READABLE, |socket| {
                recvfrom::<UnixAddr>(socket.as_raw_fd(), &mut bytes).map_err(std::io::Error::from)
            })
            .await
            .unwrap();
        assert_eq!(&bytes[..count], &[0, 255, 1, 2, 128, 3]);
        let destination = peer.unwrap();
        allowed
            .async_io(tokio::io::Interest::WRITABLE, |socket| {
                sendto(
                    socket.as_raw_fd(),
                    &bytes[..count],
                    &destination,
                    MsgFlags::empty(),
                )
                .map_err(std::io::Error::from)
            })
            .await
    };
    let (result, response) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            async {
                let result = exec(&registry, &session, &command, false).await;
                assert_eq!(result["exit_code"], 0, "{result:?}");
                result
            },
            response
        )
    })
    .await
    .unwrap();
    response.unwrap();
    assert_eq!(result["output"], "unix-datagram\n");
    let mut bytes = [0; 64];
    assert!(blocked.try_recv(&mut bytes).is_err());
    assert!(!workspace.join("unapproved.sock").exists());
    session.close().await.unwrap();
}

#[tokio::test]
async fn replacing_a_unix_alias_cannot_redirect_authorization_or_become_a_regular_file_grant() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let allowed_path = root.path().join("allowed.sock");
    let blocked_path = root.path().join("blocked.sock");
    let _allowed = UnixListener::bind(&allowed_path).unwrap();
    let blocked = UnixListener::bind(&blocked_path).unwrap();
    let alias = root.path().join("alias.sock");
    std::os::unix::fs::symlink(&allowed_path, &alias).unwrap();
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        unix_sockets: [(alias.clone(), TerminalNetworkDecision::Allow)].into(),
        ..Default::default()
    })
    .unwrap();
    let registry = tools(
        &workspace,
        SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        },
    );
    std::fs::write(
        workspace.join("probe.py"),
        include_str!("../support/unix_alias_probe.py"),
    )
    .unwrap();
    let session = AgentSession::new();
    let argument = shlex::try_quote(alias.to_str().unwrap()).unwrap();
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&blocked_path, &alias).unwrap();
    let result = exec(
        &registry,
        &session,
        &format!("python3 probe.py connect {argument}"),
        false,
    )
    .await;
    assert_eq!(result["exit_code"], 0, "{result:?}");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), blocked.accept())
            .await
            .is_err()
    );
    std::fs::remove_file(&alias).unwrap();
    std::fs::write(&alias, "outside-secret").unwrap();
    let result = exec(
        &registry,
        &session,
        &format!("python3 probe.py file {argument}"),
        false,
    )
    .await;
    assert_eq!(result["exit_code"], 0, "{result:?}");
    assert_eq!(std::fs::read_to_string(&alias).unwrap(), "outside-secret");
    session.close().await.unwrap();
}

async fn verify(all: bool) {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let allowed_path = root.path().join("allowed.sock");
    let blocked_path = root.path().join("blocked.sock");
    let allowed = UnixListener::bind(&allowed_path).unwrap();
    let blocked = UnixListener::bind(&blocked_path).unwrap();
    let allowed_alias = root.path().join("allowed-alias.sock");
    let blocked_alias = root.path().join("blocked-alias.sock");
    std::os::unix::fs::symlink(&allowed_path, &allowed_alias).unwrap();
    std::os::unix::fs::symlink(&blocked_path, &blocked_alias).unwrap();
    let secret = root.path().join("secret");
    std::fs::write(&secret, "outside-secret").unwrap();
    let mut socket_rules = [(blocked_path.clone(), TerminalNetworkDecision::Deny)]
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    if !all {
        socket_rules.insert(allowed_alias.clone(), TerminalNetworkDecision::Allow);
    }
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        unix_sockets: socket_rules,
        dangerously_allow_all_unix_sockets: all,
        ..Default::default()
    })
    .unwrap();
    let registry = tools(
        &workspace,
        SandboxConfig {
            network: NetworkAccess::Managed(policy),
            ..Default::default()
        },
    );
    std::fs::write(
        workspace.join("probe.py"),
        include_str!("../support/unix_probe.py"),
    )
    .unwrap();
    let command = format!(
        "python3 probe.py {} {} {}",
        shlex::try_quote(allowed_alias.to_str().unwrap()).unwrap(),
        shlex::try_quote(blocked_alias.to_str().unwrap()).unwrap(),
        shlex::try_quote(secret.to_str().unwrap()).unwrap(),
    );
    let session = AgentSession::new();
    let response = async {
        let (mut peer, _) = allowed.accept().await.unwrap();
        let mut data = [0; 6];
        peer.read_exact(&mut data).await.unwrap();
        assert_eq!(data, [0, 255, 1, 2, 128, 3]);
        peer.write_all(&data).await.unwrap();
        assert!(peer.read_u8().await.is_err());
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            async {
                let result = exec(&registry, &session, &command, false).await;
                assert_eq!(result["exit_code"], 0, "{result:?}");
                result
            },
            response
        )
    })
    .await
    .unwrap();
    assert_eq!(result["exit_code"], 0, "{result:?}");
    assert_eq!(result["output"], "unix\n");
    assert_eq!(std::fs::read_to_string(&secret).unwrap(), "outside-secret");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), blocked.accept())
            .await
            .is_err()
    );
    session.close().await.unwrap();
}
