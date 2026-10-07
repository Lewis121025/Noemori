use super::{TerminalNetworkProtocol, TerminalNetworkTarget, connection::Connection};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// 数据报控制连接选择自己的接收入口；进程私有入口和共享入口都保持同一目标审批契约。
pub(super) struct DatagramEndpoint {
    pub(super) hub: Arc<super::udp::Hub>,
    pub(super) address: std::net::SocketAddr,
}

/// 两种入口读取的有界认证数据；不实现 Debug，防止日志误写密码。
pub(super) struct Credentials {
    pub(super) username: Vec<u8>,
    pub(super) password: Vec<u8>,
}

/// SOCKS5 先认证再解析目标；未知命令明确拒绝，不能把 UDP 或 BIND 当成 TCP 执行。
pub(super) async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
    mut client: S,
    connection: Arc<Connection>,
    peer: std::net::SocketAddr,
) -> Result<(), String> {
    let pair = credentials(&mut client, connection.policy.config().enable_socks5).await?;
    let Some(credentials) = pair else {
        return Ok(());
    };
    let accepted = connection.authenticated(&credentials.username, &credentials.password);
    authentication_reply(&mut client, accepted).await?;
    if !accepted {
        return Ok(());
    }
    let endpoint = DatagramEndpoint {
        hub: connection.udp.clone(),
        address: std::net::SocketAddr::new(peer.ip(), connection.udp.port),
    };
    serve_authenticated(client, connection, peer, endpoint).await
}

/// 方法选择和凭据读取不涉及目标；共享入口完成归属匹配后才回复认证结果。
pub(super) async fn credentials<S: AsyncRead + AsyncWrite + Unpin>(
    client: &mut S,
    enabled: bool,
) -> Result<Option<Credentials>, String> {
    let count = client.read_u8().await.map_err(|error| error.to_string())?;
    let mut methods = vec![0; usize::from(count)];
    client
        .read_exact(&mut methods)
        .await
        .map_err(|error| error.to_string())?;
    if !enabled || !methods.contains(&2) {
        client
            .write_all(&[5, 255])
            .await
            .map_err(|error| error.to_string())?;
        return Ok(None);
    }
    client
        .write_all(&[5, 2])
        .await
        .map_err(|error| error.to_string())?;
    let version = client.read_u8().await.map_err(|error| error.to_string())?;
    let username = read_string(client).await?;
    let password = read_string(client).await?;
    if version != 1 {
        client
            .write_all(&[1, 1])
            .await
            .map_err(|error| error.to_string())?;
        return Ok(None);
    }
    Ok(Some(Credentials { username, password }))
}

/// 归属匹配后交付唯一认证结果，不重新协商已经完成的共享入口握手。
pub(super) async fn authentication_reply<S: AsyncWrite + Unpin>(
    client: &mut S,
    accepted: bool,
) -> Result<(), String> {
    client
        .write_all(&[1, u8::from(!accepted)])
        .await
        .map_err(|error| error.to_string())
}

/// 只接收已经认证的连接；调用方必须把进程身份与本次数据报入口一起交付。
pub(super) async fn serve_authenticated<S: AsyncRead + AsyncWrite + Unpin>(
    mut client: S,
    connection: Arc<Connection>,
    peer: std::net::SocketAddr,
    endpoint: DatagramEndpoint,
) -> Result<(), String> {
    let mut header = [0; 4];
    client
        .read_exact(&mut header)
        .await
        .map_err(|error| error.to_string())?;
    if header[0] != 5 || header[2] != 0 || !matches!(header[1], 1 | 3) {
        reply(&mut client, 7).await?;
        return Ok(());
    }
    let host = match header[3] {
        1 => {
            let mut address = [0; 4];
            client
                .read_exact(&mut address)
                .await
                .map_err(|error| error.to_string())?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        4 => {
            let mut address = [0; 16];
            client
                .read_exact(&mut address)
                .await
                .map_err(|error| error.to_string())?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        3 => {
            String::from_utf8(read_string(&mut client).await?).map_err(|error| error.to_string())?
        }
        _ => {
            reply(&mut client, 8).await?;
            return Ok(());
        }
    };
    let port = client.read_u16().await.map_err(|error| error.to_string())?;
    if header[1] == 3 {
        if !connection.policy.config().enable_socks5_udp {
            reply(&mut client, 7).await?;
            return Err("宿主已关闭 SOCKS5 UDP，关联未建立".into());
        }
        let ip = if host == "localhost" {
            peer.ip()
        } else {
            host.parse::<std::net::IpAddr>()
                .map_err(|error| error.to_string())?
        };
        if !ip.is_unspecified() && ip.to_canonical() != peer.ip().to_canonical() {
            reply(&mut client, 2).await?;
            return Err("UDP 关联来源地址与控制连接不一致".into());
        }
        let lease = match endpoint.hub.register(peer.ip(), port, &connection) {
            Ok(lease) => lease,
            Err(error) => {
                reply(&mut client, 2).await?;
                return Err(error);
            }
        };
        let mut bytes = vec![5, 0, 0];
        match endpoint.address.ip().to_canonical() {
            std::net::IpAddr::V4(ip) => {
                bytes.push(1);
                bytes.extend(ip.octets());
            }
            std::net::IpAddr::V6(ip) => {
                bytes.push(4);
                bytes.extend(ip.octets());
            }
        }
        bytes.extend(endpoint.address.port().to_be_bytes());
        client
            .write_all(&bytes)
            .await
            .map_err(|error| error.to_string())?;
        let mut byte = [0];
        let count = client
            .read(&mut byte)
            .await
            .map_err(|error| error.to_string())?;
        drop(lease);
        if count != 0 {
            return Err("UDP 控制连接不能传输普通字节流".into());
        }
        return Ok(());
    }
    let target = TerminalNetworkTarget::new(&host, port, TerminalNetworkProtocol::Tcp)
        .map_err(|error| error.to_string())?;
    let mut upstream = match connection.connect(target).await {
        Ok(stream) => stream,
        Err(reason) => {
            reply(&mut client, 2).await?;
            return Err(reason);
        }
    };
    reply(&mut client, 0).await?;
    tokio::io::copy_bidirectional(&mut client, &mut upstream)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn read_string<S: AsyncRead + Unpin>(client: &mut S) -> Result<Vec<u8>, String> {
    let size = client.read_u8().await.map_err(|error| error.to_string())?;
    let mut bytes = vec![0; usize::from(size)];
    client
        .read_exact(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}
async fn reply<S: AsyncWrite + Unpin>(client: &mut S, code: u8) -> Result<(), String> {
    client
        .write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|error| error.to_string())
}
