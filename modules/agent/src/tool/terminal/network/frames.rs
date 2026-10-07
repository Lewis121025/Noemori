#[cfg(any(target_os = "linux", test))]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(crate) const MAX_DATAGRAM: usize = 65535;
pub(crate) const RELAY_UDP: u8 = 255;

/// 私有网关保留数据报边界，不能将 UDP 当作普通 TCP 字节流拼接。
#[cfg(any(target_os = "linux", test))]
pub(crate) async fn read_frame<S: AsyncRead + Unpin>(
    stream: &mut S,
) -> Result<Option<Vec<u8>>, String> {
    let mut first = [0];
    if stream
        .read(&mut first)
        .await
        .map_err(|error| error.to_string())?
        == 0
    {
        return Ok(None);
    }
    let second = stream.read_u8().await.map_err(|error| error.to_string())?;
    let size = usize::from(u16::from_be_bytes([first[0], second]));
    if size == 0 {
        return Err("UDP 网关数据报不能为空".into());
    }
    let mut bytes = vec![0; size];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Some(bytes))
}
#[cfg(any(target_os = "linux", test))]
pub(crate) async fn write_frame<S: AsyncWrite + Unpin>(
    stream: &mut S,
    bytes: &[u8],
) -> Result<(), String> {
    let size = u16::try_from(bytes.len()).map_err(|_| "UDP 网关数据报超过传输预算")?;
    if size == 0 {
        return Err("UDP 网关数据报不能为空".into());
    }
    stream
        .write_all(&size.to_be_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream
        .write_all(bytes)
        .await
        .map_err(|error| error.to_string())
}
