use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

pub(crate) use super::frames::MAX_DATAGRAM;

/// 一个完整 SOCKS5 数据报；分片不能绕过目标检查，因此只接收 FRAG=0 的独立数据报。
pub(crate) struct Datagram<'a> {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) payload: &'a [u8],
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Datagram<'_>, String> {
    if bytes.len() > MAX_DATAGRAM || bytes.len() < 4 || bytes[..3] != [0, 0, 0] {
        return Err("SOCKS UDP 数据报格式无效或包含不支持的分片".into());
    }
    let (host, offset) = match bytes[3] {
        1 => {
            let value: [u8; 4] = bytes
                .get(4..8)
                .ok_or("UDP IPv4 地址不完整")?
                .try_into()
                .map_err(|error| format!("UDP IPv4 地址无效：{error}"))?;
            (Ipv4Addr::from(value).to_string(), 8)
        }
        4 => {
            let value: [u8; 16] = bytes
                .get(4..20)
                .ok_or("UDP IPv6 地址不完整")?
                .try_into()
                .map_err(|error| format!("UDP IPv6 地址无效：{error}"))?;
            (Ipv6Addr::from(value).to_string(), 20)
        }
        3 => {
            let size = usize::from(*bytes.get(4).ok_or("UDP DNS 地址缺少长度")?);
            if size == 0 {
                return Err("UDP DNS 地址不能为空".into());
            }
            let host = std::str::from_utf8(bytes.get(5..5 + size).ok_or("UDP DNS 地址不完整")?)
                .map_err(|error| error.to_string())?
                .to_owned();
            (host, 5 + size)
        }
        _ => return Err("UDP 地址类型不支持".into()),
    };
    let port = u16::from_be_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or("UDP 端口不完整")?
            .try_into()
            .map_err(|error| format!("UDP 端口无效：{error}"))?,
    );
    if port == 0 {
        return Err("UDP 目标端口不能为零".into());
    }
    Ok(Datagram {
        host,
        port,
        payload: &bytes[offset + 2..],
    })
}

pub(crate) fn encode(address: SocketAddr, payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0, 0, 0];
    match address {
        SocketAddr::V4(address) => {
            bytes.push(1);
            bytes.extend(address.ip().octets());
        }
        SocketAddr::V6(address) => {
            bytes.push(4);
            bytes.extend(address.ip().octets());
        }
    }
    bytes.extend(address.port().to_be_bytes());
    bytes.extend(payload);
    if bytes.len() > MAX_DATAGRAM {
        return Err("UDP 返回数据报超过传输预算".into());
    }
    Ok(bytes)
}
