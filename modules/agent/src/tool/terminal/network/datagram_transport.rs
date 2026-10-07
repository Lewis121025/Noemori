use super::{upstream, upstream_udp};
use std::net::SocketAddr;
use tokio::net::UdpSocket;

/// 上游路由对 TCP 和 UDP 同样生效；传输协议不支持时必须拒绝，不能绕过宿主路由。
pub(super) enum Transport {
    Direct(UdpSocket),
    Upstream(upstream_udp::Datagrams),
}

impl Transport {
    pub(super) async fn connect(
        proxy: Option<&upstream::TerminalUpstreamProxy>,
        addresses: &[SocketAddr],
    ) -> Result<Self, String> {
        if let Some(proxy) = proxy {
            let target = addresses.first().ok_or("UDP 没有可连接的目标地址")?;
            return upstream::connect_datagram(proxy, *target)
                .await
                .map(Self::Upstream);
        }
        let mut last_error = None;
        for address in addresses {
            let bound = if address.is_ipv4() {
                "0.0.0.0:0"
            } else {
                "[::]:0"
            };
            let socket = UdpSocket::bind(bound)
                .await
                .map_err(|error| error.to_string())?;
            match socket.connect(address).await {
                Ok(()) => return Ok(Self::Direct(socket)),
                Err(error) => last_error = Some(error),
            }
        }
        Err(format!("UDP 目标连接失败：{last_error:?}"))
    }

    pub(super) async fn send(&self, payload: &[u8]) -> Result<(), String> {
        match self {
            Self::Direct(socket) => socket
                .send(payload)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string()),
            Self::Upstream(datagrams) => datagrams.send(payload).await,
        }
    }

    pub(super) async fn receive(&self, bytes: &mut [u8]) -> Result<(SocketAddr, usize), String> {
        match self {
            Self::Direct(socket) => {
                let count = socket
                    .recv(bytes)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok((
                    socket.peer_addr().map_err(|error| error.to_string())?,
                    count,
                ))
            }
            Self::Upstream(datagrams) => datagrams.receive(bytes).await,
        }
    }
}
