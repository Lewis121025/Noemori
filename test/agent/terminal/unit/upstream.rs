use super::*;
use std::{
    net::{IpAddr, Ipv6Addr},
    time::Duration,
};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

async fn server() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

async fn authenticate(peer: &mut TcpStream, credentials: bool) {
    let mut greeting = [0; 3];
    peer.read_exact(&mut greeting).await.unwrap();
    assert_eq!(greeting, [5, 1, if credentials { 2 } else { 0 }]);
    peer.write_all(&[5, greeting[2]]).await.unwrap();
    if credentials {
        let mut auth = [0; 19];
        peer.read_exact(&mut auth).await.unwrap();
        assert_eq!(&auth, b"\x01\x04user\x0cproxy-secret");
        peer.write_all(&[1, 0]).await.unwrap();
    }
}

async fn read_header(peer: &mut (impl AsyncRead + Unpin)) -> Vec<u8> {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        header.push(peer.read_u8().await.unwrap());
        assert!(header.len() <= 32768);
    }
    header
}

#[test]
fn upstream_configuration_is_bounded_and_debug_never_discloses_credentials() {
    let proxy =
        TerminalUpstreamProxy::new("http://us%65r:private-password@EXAMPLE.com:8080/").unwrap();
    let debug = format!("{proxy:?}");
    assert!(debug.contains("example.com:8080"));
    assert!(!debug.contains("private-password"));
    assert!(!debug.contains("user"));
    let parsed = proxy.parsed().unwrap();
    assert_eq!(parsed.credentials.unwrap().username, "user");
    for url in [
        "ftp://example.com",
        "http://example.com:0",
        "http://example.com/path",
        "https://example.com?query",
        "socks5://example.com#fragment",
        "socks5://user@example.com",
        "socks5://:secret@example.com",
        "http://user:%0a@example.com",
        "http://user:%ff@example.com",
    ] {
        assert!(TerminalUpstreamProxy::new(url).is_err(), "{url}");
    }
    assert!(
        TerminalUpstreamProxy::new(&format!("http://user:{}@example.com", "a".repeat(9000)))
            .is_err()
    );
    assert!(
        proxy
            .clone()
            .with_trusted_roots(vec![vec![0; 65537]])
            .is_err()
    );
    assert!(proxy.with_trusted_roots(vec![vec![1, 2, 3]]).is_err());
    let invalid: TerminalUpstreamProxy =
        serde_json::from_value(serde_json::json!({"url":"file:///tmp/socket"})).unwrap();
    assert!(
        super::super::TerminalNetworkPolicy::new(super::super::TerminalNetworkConfig {
            upstream_proxy: Some(invalid),
            ..Default::default()
        })
        .is_err()
    );
}

#[tokio::test]
async fn socks_upstream_authenticates_and_uses_pinned_ipv6_for_both_url_schemes() {
    for credentials in [false, true] {
        let (listener, port) = server().await;
        let scheme = if credentials { "socks5h" } else { "socks5" };
        let auth = if credentials {
            "user:proxy-secret@"
        } else {
            ""
        };
        let proxy =
            TerminalUpstreamProxy::new(&format!("{scheme}://{auth}127.0.0.1:{port}")).unwrap();
        let target = SocketAddr::new(
            IpAddr::V6("2001:db8::1234".parse::<Ipv6Addr>().unwrap()),
            443,
        );
        let remote = async {
            let (mut peer, _) = listener.accept().await.unwrap();
            authenticate(&mut peer, credentials).await;
            let mut request = [0; 22];
            peer.read_exact(&mut request).await.unwrap();
            assert_eq!(&request[..4], &[5, 1, 0, 4]);
            assert_eq!(
                &request[4..20],
                &"2001:db8::1234".parse::<Ipv6Addr>().unwrap().octets()
            );
            assert_eq!(&request[20..], &443_u16.to_be_bytes());
            peer.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
            peer.write_all(b"\x00\xffearly").await.unwrap();
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            let addresses = [target];
            let (stream, ()) = tokio::join!(connect(&proxy, &addresses), remote);
            let mut stream = stream.unwrap();
            let mut bytes = [0; 7];
            stream.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"\x00\xffearly");
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn http_connect_preserves_prefetched_tunnel_bytes_and_rejects_failed_or_oversized_headers() {
    for response in [
        b"HTTP/1.1 200 OK\r\n\r\n\x00\xffearly".to_vec(),
        b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nX: "
            .iter()
            .copied()
            .chain(std::iter::repeat_n(b'a', 33000))
            .collect(),
    ] {
        let (listener, port) = server().await;
        let proxy = TerminalUpstreamProxy::new(&format!("http://127.0.0.1:{port}")).unwrap();
        let success = response.ends_with(b"\x00\xffearly");
        let remote = async {
            let (mut peer, _) = listener.accept().await.unwrap();
            let header = read_header(&mut peer).await;
            assert!(header.starts_with(b"CONNECT 192.0.2.1:443 HTTP/1.1\r\n"));
            let _ = peer.write_all(&response).await;
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            let addresses = ["192.0.2.1:443".parse().unwrap()];
            let (result, ()) = tokio::join!(connect(&proxy, &addresses), remote);
            if success {
                let mut stream = result.unwrap();
                let mut bytes = [0; 7];
                stream.read_exact(&mut bytes).await.unwrap();
                assert_eq!(&bytes, b"\x00\xffearly");
            } else {
                assert!(result.is_err());
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn socks_udp_upstream_pins_target_filters_packets_and_closes_with_control() {
    for credentials in [false, true] {
        let (listener, port) = server().await;
        let relay = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let relay_port = relay.local_addr().unwrap().port();
        let auth = if credentials {
            "user:proxy-secret@"
        } else {
            ""
        };
        let proxy =
            TerminalUpstreamProxy::new(&format!("socks5://{auth}127.0.0.1:{port}")).unwrap();
        let target: SocketAddr = "[2001:db8::1234]:443".parse().unwrap();
        let setup = async {
            let (mut peer, _) = listener.accept().await.unwrap();
            authenticate(&mut peer, credentials).await;
            let mut request = [0; 10];
            peer.read_exact(&mut request).await.unwrap();
            assert_eq!(&request, &[5, 3, 0, 1, 0, 0, 0, 0, 0, 0]);
            let mut reply = vec![5, 0, 0, 1, 0, 0, 0, 0];
            reply.extend(relay_port.to_be_bytes());
            peer.write_all(&reply).await.unwrap();
            peer
        };
        let (datagrams, control) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(connect_datagram(&proxy, target), setup)
        })
        .await
        .unwrap();
        let datagrams = datagrams.unwrap();
        let payload = b"\x00\xff\x01\x02\x80\x03";
        datagrams.send(payload).await.unwrap();
        let mut packet = [0; 64];
        let (count, source) =
            tokio::time::timeout(Duration::from_secs(1), relay.recv_from(&mut packet))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(&packet[..4], &[0, 0, 0, 4]);
        assert_eq!(
            &packet[4..20],
            &"2001:db8::1234".parse::<Ipv6Addr>().unwrap().octets()
        );
        assert_eq!(&packet[20..22], &443_u16.to_be_bytes());
        assert_eq!(&packet[22..count], payload);
        let unauthorized = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        unauthorized
            .send_to(&packet[..count], source)
            .await
            .unwrap();
        let mut invalid = packet[..count].to_vec();
        invalid[2] = 1;
        relay.send_to(&invalid, source).await.unwrap();
        invalid[2] = 0;
        invalid[21] ^= 1;
        relay.send_to(&invalid, source).await.unwrap();
        relay.send_to(&packet[..count], source).await.unwrap();
        let mut bytes = [0; 64];
        let (actual, count) =
            tokio::time::timeout(Duration::from_secs(1), datagrams.receive(&mut bytes))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(actual, target);
        assert_eq!(&bytes[..count], payload);
        drop(control);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), datagrams.receive(&mut bytes))
                .await
                .unwrap()
                .is_err()
        );
        assert!(datagrams.send(payload).await.is_err());
    }
}

#[tokio::test]
async fn socks_udp_relay_can_use_a_different_address_family_than_its_control_connection() {
    for (tcp_address, udp_address) in [("127.0.0.1:0", "[::1]:0"), ("[::1]:0", "127.0.0.1:0")] {
        let listener = TcpListener::bind(tcp_address).await.unwrap();
        let relay = UdpSocket::bind(udp_address).await.unwrap();
        let relay_address = relay.local_addr().unwrap();
        let proxy =
            TerminalUpstreamProxy::new(&format!("socks5://{}", listener.local_addr().unwrap()))
                .unwrap();
        let target: SocketAddr = "192.0.2.1:443".parse().unwrap();
        let setup = async {
            let (mut peer, _) = listener.accept().await.unwrap();
            authenticate(&mut peer, false).await;
            let mut request = [0; 10];
            peer.read_exact(&mut request).await.unwrap();
            assert_eq!(request, [5, 3, 0, 1, 0, 0, 0, 0, 0, 0]);
            let mut reply = vec![5, 0, 0];
            match relay_address.ip() {
                IpAddr::V4(ip) => {
                    reply.push(1);
                    reply.extend(ip.octets());
                }
                IpAddr::V6(ip) => {
                    reply.push(4);
                    reply.extend(ip.octets());
                }
            }
            reply.extend(relay_address.port().to_be_bytes());
            peer.write_all(&reply).await.unwrap();
            peer
        };
        let (result, control) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(connect_datagram(&proxy, target), setup)
        })
        .await
        .unwrap();
        let datagrams = result.unwrap();
        let payload = b"\x00\xffdifferent-family";
        datagrams.send(payload).await.unwrap();
        let mut packet = [0; 64];
        let (count, source) =
            tokio::time::timeout(Duration::from_secs(1), relay.recv_from(&mut packet))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(&packet[..8], &[0, 0, 0, 1, 192, 0, 2, 1]);
        assert_eq!(&packet[10..count], payload);
        relay.send_to(&packet[..count], source).await.unwrap();
        let mut bytes = [0; 64];
        let (actual, count) =
            tokio::time::timeout(Duration::from_secs(1), datagrams.receive(&mut bytes))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(actual, target);
        assert_eq!(&bytes[..count], payload);
        drop(control);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), datagrams.receive(&mut bytes))
                .await
                .unwrap()
                .is_err()
        );
    }
}

#[tokio::test]
async fn cancelled_upstream_handshake_releases_the_socket() {
    let (listener, port) = server().await;
    let proxy = TerminalUpstreamProxy::new(&format!("http://127.0.0.1:{port}")).unwrap();
    let stop = crate::CancellationToken::new();
    let context = crate::ExecutionContext::new(stop.clone(), Duration::from_secs(5)).unwrap();
    let remote = async {
        let (mut peer, _) = listener.accept().await.unwrap();
        read_header(&mut peer).await;
        stop.cancel();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), peer.read_u8())
                .await
                .unwrap()
                .is_err()
        );
    };
    let addresses = ["192.0.2.1:443".parse().unwrap()];
    let (result, ()) = tokio::join!(context.wait(connect(&proxy, &addresses)), remote);
    assert!(matches!(result, Err(crate::Error::Cancelled)));
}

#[tokio::test]
async fn https_upstream_verifies_custom_roots_and_hostname_without_changing_system_trust() {
    use tokio_rustls::rustls::{
        ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    };
    // 每次生成短期 localhost 叶证书，遵守系统 TLS 标准且不安装到系统信任库。
    let mut ca_params = rcgen::CertificateParams::new(Vec::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::CrlSign,
    ];
    ca_params.not_before = (std::time::SystemTime::now() - Duration::from_secs(86400)).into();
    ca_params.not_after = (std::time::SystemTime::now() + Duration::from_secs(86400 * 7)).into();
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let root = ca_params.self_signed(&ca_key).unwrap();
    let mut params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
    params.not_before = ca_params.not_before;
    params.not_after = ca_params.not_after;
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    params.use_authority_key_identifier_extension = true;
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = params
        .signed_by(&key, &rcgen::Issuer::new(ca_params, ca_key))
        .unwrap();
    for (host, trusted, success) in [
        ("localhost", true, true),
        ("localhost", false, false),
        ("127.0.0.1", true, false),
    ] {
        let (listener, port) = server().await;
        let mut proxy = TerminalUpstreamProxy::new(&format!("https://{host}:{port}")).unwrap();
        if trusted {
            proxy = proxy.with_trusted_roots(vec![root.der().to_vec()]).unwrap();
        }
        let config = ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.der().to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let remote = async {
            let (peer, _) = listener.accept().await.unwrap();
            let result = acceptor.accept(peer).await;
            if let Ok(mut tls) = result
                && success
            {
                let header = read_header(&mut tls).await;
                assert!(header.starts_with(b"CONNECT 192.0.2.1:443 HTTP/1.1\r\n"));
                tls.write_all(b"HTTP/1.1 200 OK\r\n\r\n\x00\xffearly")
                    .await
                    .unwrap();
            }
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            let addresses = ["192.0.2.1:443".parse().unwrap()];
            let (result, ()) = tokio::join!(connect(&proxy, &addresses), remote);
            if success {
                let mut stream = result.unwrap();
                let mut bytes = [0; 7];
                stream.read_exact(&mut bytes).await.unwrap();
                assert_eq!(&bytes, b"\x00\xffearly");
            } else {
                assert!(result.err().unwrap().contains("TLS 验证失败"));
            }
        })
        .await
        .unwrap();
    }
}
