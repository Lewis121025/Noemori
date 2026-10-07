use super::{
    config::RelayConfig,
    frames::{self, MAX_DATAGRAM, RELAY_UDP},
};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UdpSocket,
    sync::mpsc,
    task::JoinSet,
};

/// 命名空间内数据报按来源端口建立独立的已认证通道，流式网关中的帧长度保留 UDP 边界。
pub(super) async fn run(socket: Arc<UdpSocket>, config: Arc<RelayConfig>) -> Result<(), String> {
    let mut routes: HashMap<SocketAddr, (uuid::Uuid, mpsc::Sender<Vec<u8>>)> = HashMap::new();
    let mut tasks = JoinSet::new();
    let mut packet = vec![0; MAX_DATAGRAM];
    loop {
        tokio::select! {
            result=tasks.join_next(),if !tasks.is_empty()=>{
                let (peer,id,outcome)=result.ok_or("UDP 转发任务没有返回结果")?.map_err(|error|error.to_string())?;
                if routes.get(&peer).is_some_and(|(current,_)|*current==id) {routes.remove(&peer);}
                if let Err(error)=outcome {eprintln!("命名空间 UDP 转发结束：{error}");}
            },
            received=socket.recv_from(&mut packet)=>{
                let (size,peer)=received.map_err(|error|error.to_string())?;
                if !peer.ip().is_loopback() {continue;}
                if !routes.contains_key(&peer) {
                    if routes.len()>=64 {eprintln!("命名空间 UDP 来源达到 64 项上限");continue;}
                    let id=uuid::Uuid::new_v4();let (sender,receiver)=mpsc::channel(8);routes.insert(peer,(id,sender));
                    let config=config.clone();let replies=socket.clone();
                    tasks.spawn(async move {(peer,id,forward(peer,replies,config,receiver).await)});
                }
                if let Some((_,sender))=routes.get(&peer) && let Err(error)=sender.try_send(packet[..size].to_vec()) {eprintln!("命名空间 UDP 数据报队列不可用：{error}");}
            },
        }
    }
}

async fn forward(
    peer: SocketAddr,
    socket: Arc<UdpSocket>,
    config: Arc<RelayConfig>,
    mut packets: mpsc::Receiver<Vec<u8>>,
) -> Result<(), String> {
    let mut gateway = tokio::net::UnixStream::connect(&config.gateway)
        .await
        .map_err(|error| error.to_string())?;
    gateway
        .write_all(config.password.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    gateway
        .write_u8(RELAY_UDP)
        .await
        .map_err(|error| error.to_string())?;
    gateway
        .write_u16(peer.port())
        .await
        .map_err(|error| error.to_string())?;
    match gateway.read_u8().await.map_err(|error| error.to_string())? {
        0 => {}
        1 => return Ok(()),
        _ => return Err("UDP 网关返回无效关联响应".into()),
    }
    let (mut read, mut write) = tokio::io::split(gateway);
    let sending = async {
        while let Some(bytes) = packets.recv().await {
            frames::write_frame(&mut write, &bytes).await?;
        }
        Ok::<_, String>(())
    };
    let receiving = async {
        while let Some(bytes) = frames::read_frame(&mut read).await? {
            socket
                .send_to(&bytes, peer)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok::<_, String>(())
    };
    tokio::select! {result=sending=>result,result=receiving=>result}
}
