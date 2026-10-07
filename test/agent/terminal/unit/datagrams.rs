use super::{datagram_codec, frames};

#[test]
fn udp_headers_keep_ipv4_ipv6_domains_and_binary_payloads_without_accepting_fragments() {
    for address in ["127.0.0.1:443", "[::1]:53"] {
        let address = address.parse::<std::net::SocketAddr>().unwrap();
        let packet = datagram_codec::encode(address, &[0, 255, 128]).unwrap();
        let decoded = datagram_codec::decode(&packet).unwrap();
        assert_eq!(decoded.host, address.ip().to_string());
        assert_eq!(decoded.port, address.port());
        assert_eq!(decoded.payload, &[0, 255, 128]);
        for size in 0..packet.len() - 3 {
            assert!(datagram_codec::decode(&packet[..size]).is_err());
        }
        let mut fragmented = packet.clone();
        fragmented[2] = 1;
        assert!(datagram_codec::decode(&fragmented).is_err());
    }
    let mut domain = vec![0, 0, 0, 3, 11];
    domain.extend(b"example.com");
    domain.extend(5353u16.to_be_bytes());
    domain.extend([0, 255]);
    let decoded = datagram_codec::decode(&domain).unwrap();
    assert_eq!(decoded.host, "example.com");
    assert_eq!(decoded.port, 5353);
    assert_eq!(decoded.payload, &[0, 255]);
    assert!(datagram_codec::decode(&[0, 0, 0, 1, 127, 0, 0, 1, 0, 0]).is_err());
}

#[tokio::test]
async fn private_gateway_framing_preserves_multiple_datagrams_and_rejects_truncated_packets() {
    let (mut writer, mut reader) = tokio::io::duplex(16);
    let send = async {
        frames::write_frame(&mut writer, &[0, 255, 1])
            .await
            .unwrap();
        frames::write_frame(&mut writer, &[128, 2]).await.unwrap();
        drop(writer);
    };
    let receive = async {
        assert_eq!(
            frames::read_frame(&mut reader).await.unwrap(),
            Some(vec![0, 255, 1])
        );
        assert_eq!(
            frames::read_frame(&mut reader).await.unwrap(),
            Some(vec![128, 2])
        );
        assert!(frames::read_frame(&mut reader).await.unwrap().is_none());
    };
    tokio::join!(send, receive);
    let mut malformed = &[0, 4, 1, 2][..];
    assert!(frames::read_frame(&mut malformed).await.is_err());
    let mut empty = &[0, 0][..];
    assert!(frames::read_frame(&mut empty).await.is_err());
}
