use super::{
    datagram_codec,
    upstream::{BoundAddress, Stream, socks_command},
};
use crate::CancellationToken;
use std::net::SocketAddr;
use tokio::{io::AsyncReadExt, net::UdpSocket, sync::Mutex};

/// 每个已授权目标独占上游 UDP 关联；控制连接结束后，数据报通道不得继续存活。
pub(super) struct Datagrams {
    socket: UdpSocket,
    target: SocketAddr,
    control: Mutex<Stream>,
    closed: CancellationToken,
}

impl Datagrams {
    pub(super) async fn connect(
        mut control: Stream,
        peer: SocketAddr,
        target: SocketAddr,
    ) -> Result<Self, String> {
        // RFC 1928 允许未知 UDP 来源使用全零地址；收到中继后才选择地址族和本地端口。
        // TCP 的路由不能代替 UDP 中继路由，二者可使用不同接口和地址族。
        let bound = socks_command(
            &mut control,
            3,
            SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, 0)),
        )
        .await?;
        let relay = match bound {
            BoundAddress::Ip(mut address) => {
                if address.ip().is_unspecified() {
                    address.set_ip(peer.ip());
                }
                address
            }
            BoundAddress::Host(host, port) => {
                // 中继是宿主信任的上游提供的路由，只解析一次；业务目标始终使用已授权 IP。
                let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), port))
                    .await
                    .map_err(|error| error.to_string())?
                    .collect();
                addresses
                    .iter()
                    .find(|address| address.is_ipv4() == peer.is_ipv4())
                    .or(addresses.first())
                    .copied()
                    .ok_or("上游 UDP 中继没有可连接的地址")?
            }
        };
        if relay.port() == 0 {
            return Err("上游 UDP 中继端口无效".into());
        }
        let bound = if relay.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let socket = UdpSocket::bind(bound)
            .await
            .map_err(|error| error.to_string())?;
        socket
            .connect(relay)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self {
            socket,
            target,
            control: Mutex::new(control),
            closed: CancellationToken::new(),
        })
    }

    pub(super) async fn send(&self, payload: &[u8]) -> Result<(), String> {
        let packet = datagram_codec::encode(self.target, payload)?;
        tokio::select! {
            biased;
            _ = self.closed.cancelled() => Err("上游 UDP 控制连接已经关闭".into()),
            result = self.socket.send(&packet) => result.map(|_| ()).map_err(|error| error.to_string()),
        }
    }

    pub(super) async fn receive(&self, bytes: &mut [u8]) -> Result<(SocketAddr, usize), String> {
        let mut control = self.control.lock().await;
        let result = async {
            // 多一个字节用于发现超预算数据报，避免截断后误当成合法报文。
            let mut packet = vec![0; datagram_codec::MAX_DATAGRAM + 1];
            loop {
                let count = tokio::select! {
                    biased;
                    _ = self.closed.cancelled() => return Err("上游 UDP 控制连接已经关闭".into()),
                    result = control.read_u8() => return Err(match result {
                        Ok(_) => "上游 UDP 控制连接返回了协议外数据".into(),
                        Err(error) => format!("上游 UDP 控制连接已经结束：{error}"),
                    }),
                    result = self.socket.recv(&mut packet) => result.map_err(|error| error.to_string())?,
                };
                let Ok(datagram) = datagram_codec::decode(&packet[..count]) else { continue };
                let Ok(ip) = datagram.host.parse::<std::net::IpAddr>() else { continue };
                if ip.to_canonical() != self.target.ip().to_canonical() || datagram.port != self.target.port() {
                    continue;
                }
                if datagram.payload.len() > bytes.len() {
                    return Err("上游 UDP 数据报超过接收预算".into());
                }
                bytes[..datagram.payload.len()].copy_from_slice(datagram.payload);
                return Ok((self.target, datagram.payload.len()));
            }
        }.await;
        if result.is_err() {
            self.closed.cancel();
        }
        result
    }
}
