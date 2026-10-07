use super::{TerminalProxyProtocol, prefix::Prefix, shared::Server};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::OwnedSemaphorePermit,
};

/// 共享入口先找到进程归属，再把完整 HTTP 标头或已认证 SOCKS 请求交给同一执行链路。
pub(super) async fn serve(
    mut socket: TcpStream,
    server: Arc<Server>,
    peer: SocketAddr,
    permit: OwnedSemaphorePermit,
) {
    let selection = async {
        let first = socket.read_u8().await.map_err(|error| error.to_string())?;
        if first == 5 {
            let pair = super::socks::credentials(
                &mut socket,
                server.protocol_available(TerminalProxyProtocol::Socks5),
            )
            .await?;
            let Some(credentials) = pair else {
                return Ok(None);
            };
            let selected = server
                .authenticated(
                    &credentials.username,
                    &credentials.password,
                    TerminalProxyProtocol::Socks5,
                )
                .filter(|connection| connection.policy.config().enable_socks5);
            super::socks::authentication_reply(&mut socket, selected.is_some()).await?;
            Ok(selected.map(|connection| (connection, Vec::new(), true)))
        } else {
            let bytes = header(&mut socket, first).await?;
            let mut fields = [httparse::EMPTY_HEADER; 128];
            let mut request = httparse::Request::new(&mut fields);
            request
                .parse(&bytes)
                .map_err(|_| "共享代理 HTTP 标头无效")?;
            let mut values = request
                .headers
                .iter()
                .filter(|field| field.name.eq_ignore_ascii_case("proxy-authorization"));
            let selected = values
                .next()
                .and_then(|field| credentials(field.value))
                .and_then(|credentials| {
                    server.authenticated(
                        &credentials.username,
                        &credentials.password,
                        TerminalProxyProtocol::Http,
                    )
                });
            if values.next().is_some() || selected.is_none() {
                socket.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Noemori\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.map_err(|error| error.to_string())?;
                return Ok(None);
            }
            Ok::<_, String>(selected.map(|connection| (connection, bytes, false)))
        }
    };
    let selected = tokio::select! {
        biased;
        _ = server.stop.cancelled() => return,
        result = tokio::time::timeout(Duration::from_secs(10), selection) => match result {
            Ok(Ok(Some(value))) => value,
            Ok(Ok(None)) => return,
            Ok(Err(error)) => { eprintln!("共享代理握手失败：{error}"); return; }
            Err(_) => { eprintln!("共享代理握手超过 10 秒预算"); return; }
        },
    };
    let (connection, bytes, socks) = selected;
    let address = match socket.local_addr() {
        Ok(address) => address,
        Err(error) => {
            connection.report(
                None,
                false,
                Some(format!("共享代理实际地址读取失败：{error}")),
            );
            return;
        }
    };
    let endpoint = super::socks::DatagramEndpoint {
        hub: server.udp.clone(),
        address,
    };
    let tracker = connection.tasks.clone();
    tracker.spawn(async move {
        let _permit = permit;
        let operation = async {
            if socks { super::socks::serve_authenticated(socket, connection.clone(), peer, endpoint).await }
            else { super::http::serve(Prefix::new(socket, bytes), connection.clone()).await }
        };
        tokio::select! {
            biased;
            _ = connection.process.stop.cancelled() => {},
            result = operation => if let Err(error) = result { connection.report(None, false, Some(error)); },
        }
    });
}

async fn header(socket: &mut TcpStream, first: u8) -> Result<Vec<u8>, String> {
    let mut bytes = vec![first];
    while !bytes.windows(4).any(|value| value == b"\r\n\r\n") {
        if bytes.len() == 32768 {
            return Err("共享代理 HTTP 标头超过 32 KiB 预算".into());
        }
        let mut chunk = [0; 4096];
        let remaining = (32768 - bytes.len()).min(chunk.len());
        let count = socket
            .read(&mut chunk[..remaining])
            .await
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("共享代理 HTTP 标头未完成".into());
        }
        bytes.extend(&chunk[..count]);
    }
    Ok(bytes)
}

fn credentials(value: &[u8]) -> Option<super::socks::Credentials> {
    let text = std::str::from_utf8(value).ok()?;
    let (scheme, encoded) = text.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let value = STANDARD.decode(encoded.trim()).ok()?;
    let split = value.iter().position(|byte| *byte == b':')?;
    Some(super::socks::Credentials {
        username: value[..split].to_vec(),
        password: value[split + 1..].to_vec(),
    })
}
