use super::*;
use policy::public_address;

#[test]
fn proxy_listener_configuration_requires_explicit_non_loopback_access_and_round_trips() {
    for address in ["0.0.0.0:3128", "192.0.2.1:1080", "[::]:1080"] {
        let listener = TerminalProxyListener {
            address: address.parse().unwrap(),
            allow_non_loopback: false,
        };
        assert!(
            TerminalNetworkPolicy::new(TerminalNetworkConfig {
                http_listener: Some(listener.clone()),
                ..Default::default()
            })
            .is_err()
        );
        let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
            http_listener: Some(TerminalProxyListener {
                allow_non_loopback: true,
                ..listener
            }),
            ..Default::default()
        })
        .unwrap();
        let restored =
            TerminalNetworkPolicy::from_json(policy.to_json().unwrap().as_bytes()).unwrap();
        assert_eq!(
            restored.config().http_listener,
            policy.config().http_listener
        );
        assert_eq!(restored.fingerprint(), policy.fingerprint());
    }
    for address in ["127.0.0.1:0", "[::1]:0"] {
        assert!(
            TerminalNetworkPolicy::new(TerminalNetworkConfig {
                socks_listener: Some(TerminalProxyListener {
                    address: address.parse().unwrap(),
                    allow_non_loopback: false
                }),
                ..Default::default()
            })
            .is_ok()
        );
    }
}

#[test]
fn socks_protocol_defaults_and_serialized_switches_share_one_contract() {
    let defaults = TerminalNetworkConfig::default();
    assert!(defaults.enable_socks5);
    assert!(defaults.enable_socks5_udp);
    let from_json: TerminalNetworkConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(from_json.enable_socks5, defaults.enable_socks5);
    assert_eq!(from_json.enable_socks5_udp, defaults.enable_socks5_udp);
    let original = TerminalNetworkPolicy::new(defaults).unwrap();
    assert!(!original.to_json().unwrap().contains("enable_socks5"));
    for (tcp, udp) in [(false, true), (true, false), (false, false)] {
        let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
            enable_socks5: tcp,
            enable_socks5_udp: udp,
            ..Default::default()
        })
        .unwrap();
        assert_ne!(policy.fingerprint(), original.fingerprint());
        let saved = TerminalNetworkPolicy::from_json(policy.to_json().unwrap().as_bytes()).unwrap();
        assert_eq!(saved.config().enable_socks5, tcp);
        assert_eq!(saved.config().enable_socks5_udp, udp);
        assert_eq!(saved.fingerprint(), policy.fingerprint());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn unix_socket_rules_canonicalize_aliases_and_denial_wins_without_expanding_file_access() {
    use std::os::unix::net::UnixListener;
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("service.sock");
    let _listener = UnixListener::bind(&socket).unwrap();
    let alias = root.path().join("alias.sock");
    std::os::unix::fs::symlink(&socket, &alias).unwrap();
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        unix_sockets: [
            (alias, TerminalNetworkDecision::Allow),
            (socket.clone(), TerminalNetworkDecision::Deny),
        ]
        .into(),
        ..Default::default()
    })
    .unwrap();
    let normalized = socket.canonicalize().unwrap();
    assert_eq!(policy.unix().rules.len(), 1);
    assert_eq!(
        policy.unix().rules.get(&normalized),
        Some(&TerminalNetworkDecision::Deny)
    );
    let reloaded = TerminalNetworkPolicy::from_json(policy.to_json().unwrap().as_bytes()).unwrap();
    assert_eq!(reloaded.config().unix_sockets, policy.config().unix_sockets);
    assert_eq!(reloaded.fingerprint(), policy.fingerprint());
}

#[test]
fn invalid_unix_socket_rules_are_rejected_before_process_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("ordinary-file");
    std::fs::write(&file, "secret").unwrap();
    for path in [
        std::path::PathBuf::from("relative.sock"),
        root.path().join("bad\n.sock"),
        file,
    ] {
        assert!(
            TerminalNetworkPolicy::new(TerminalNetworkConfig {
                unix_sockets: [(path, TerminalNetworkDecision::Allow)].into(),
                ..Default::default()
            })
            .is_err()
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn unix_socket_fingerprint_tracks_frozen_alias_targets_and_rejects_dangling_links() {
    use std::os::unix::net::UnixListener;
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first.sock");
    let second = root.path().join("second.sock");
    let _first = UnixListener::bind(&first).unwrap();
    let _second = UnixListener::bind(&second).unwrap();
    let alias = root.path().join("alias.sock");
    std::os::unix::fs::symlink(&first, &alias).unwrap();
    let config = TerminalNetworkConfig {
        unix_sockets: [(alias.clone(), TerminalNetworkDecision::Allow)].into(),
        ..Default::default()
    };
    let original = TerminalNetworkPolicy::new(config.clone()).unwrap();
    assert_eq!(
        original.fingerprint(),
        TerminalNetworkPolicy::from_json(original.to_json().unwrap().as_bytes())
            .unwrap()
            .fingerprint()
    );
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&second, &alias).unwrap();
    let changed = TerminalNetworkPolicy::new(config.clone()).unwrap();
    assert_ne!(original.fingerprint(), changed.fingerprint());
    assert!(
        original
            .unix()
            .rules
            .contains_key(&first.canonicalize().unwrap())
    );
    assert!(
        !original
            .unix()
            .rules
            .contains_key(&second.canonicalize().unwrap())
    );
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(root.path().join("missing.sock"), &alias).unwrap();
    assert!(TerminalNetworkPolicy::new(config).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn unsupported_unix_socket_policy_is_explicit_instead_of_silently_allowing_unrestricted_unix() {
    let root = tempfile::tempdir().unwrap();
    let error = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        unix_sockets: [(
            root.path().join("service.sock"),
            TerminalNetworkDecision::Allow,
        )]
        .into(),
        ..Default::default()
    })
    .unwrap_err();
    assert!(error.to_string().contains("Unix socket"));
    assert!(
        TerminalNetworkPolicy::new(TerminalNetworkConfig {
            dangerously_allow_all_unix_sockets: true,
            ..Default::default()
        })
        .is_err()
    );
}

fn rule(pattern: &str, decision: TerminalNetworkDecision) -> TerminalNetworkRule {
    TerminalNetworkRule {
        pattern: pattern.into(),
        protocols: vec![],
        ports: vec![],
        decision,
    }
}
fn target(host: &str, port: u16, protocol: TerminalNetworkProtocol) -> TerminalNetworkTarget {
    TerminalNetworkTarget::new(host, port, protocol).unwrap()
}

#[test]
fn domain_rules_normalize_aliases_and_denial_wins_across_ports_and_protocols() {
    let mut allowed = rule("**.Example.COM.", TerminalNetworkDecision::Allow);
    allowed.ports = vec![443];
    allowed.protocols = vec![TerminalNetworkProtocol::Tcp];
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![
            allowed,
            rule("blocked.example.com", TerminalNetworkDecision::Deny),
        ],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        policy
            .decision(&target("EXAMPLE.com.", 443, TerminalNetworkProtocol::Tcp))
            .unwrap(),
        Some(TerminalNetworkDecision::Allow)
    );
    assert_eq!(
        policy
            .decision(&target(
                "a.b.example.com",
                443,
                TerminalNetworkProtocol::Tcp
            ))
            .unwrap(),
        Some(TerminalNetworkDecision::Allow)
    );
    assert_eq!(
        policy
            .decision(&target(
                "blocked.example.com",
                443,
                TerminalNetworkProtocol::Tcp
            ))
            .unwrap(),
        Some(TerminalNetworkDecision::Deny)
    );
    for destination in [
        target("example.com.evil", 443, TerminalNetworkProtocol::Tcp),
        target("example.com", 80, TerminalNetworkProtocol::Tcp),
        target("example.com", 443, TerminalNetworkProtocol::Udp),
    ] {
        assert_eq!(policy.decision(&destination).unwrap(), None);
    }
    let subdomain = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![rule("*.example.com", TerminalNetworkDecision::Allow)],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        subdomain
            .decision(&target("example.com", 443, TerminalNetworkProtocol::Tcp))
            .unwrap(),
        None
    );
    assert_eq!(
        target("2130706433", 80, TerminalNetworkProtocol::Tcp).host,
        "127.0.0.1"
    );
    assert_eq!(
        target("[::ffff:127.0.0.1]", 80, TerminalNetworkProtocol::Tcp).host,
        "127.0.0.1"
    );
}

#[test]
fn local_network_access_requires_explicit_local_scope_and_translated_addresses_are_checked() {
    let all = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![rule("*", TerminalNetworkDecision::Allow)],
        ..Default::default()
    })
    .unwrap();
    let local = target("127.0.0.1", 80, TerminalNetworkProtocol::Tcp);
    assert!(!all.permits_private(&local, false));
    assert!(all.permits_private(&local, true));
    assert!(!all.permits_private(
        &target("public.example", 80, TerminalNetworkProtocol::Tcp),
        true
    ));
    for address in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "192.168.1.1",
        "100.64.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "64:ff9b::7f00:1",
        "fc00::1",
        "fe80::1",
    ] {
        assert!(!public_address(address.parse().unwrap()), "{address}");
    }
    for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
        assert!(public_address(address.parse().unwrap()), "{address}");
    }
}

#[test]
fn policy_json_is_versioned_and_rejects_invalid_hosts_and_unknown_fields() {
    let policy = TerminalNetworkPolicy::new(TerminalNetworkConfig {
        rules: vec![rule("API.EXAMPLE.COM", TerminalNetworkDecision::Allow)],
        ..Default::default()
    })
    .unwrap();
    let decoded = TerminalNetworkPolicy::from_json(policy.to_json().unwrap().as_bytes()).unwrap();
    assert_eq!(policy.fingerprint(), decoded.fingerprint());
    assert_ne!(policy, decoded);
    for host in [
        "",
        "a..example",
        "example/secret",
        "foo@example.com",
        " foo.example",
        "example.com\n",
        "*.127.0.0.1",
        "api*.example.com",
    ] {
        assert!(
            TerminalNetworkPolicy::new(TerminalNetworkConfig {
                rules: vec![rule(host, TerminalNetworkDecision::Allow)],
                ..Default::default()
            })
            .is_err(),
            "{host}"
        );
    }
    for bytes in [
        br#"{"version":2,"config":{}}"#.as_slice(),
        br#"{"version":1,"config":{"unknown":true}}"#.as_slice(),
    ] {
        assert!(TerminalNetworkPolicy::from_json(bytes).is_err());
    }
}
