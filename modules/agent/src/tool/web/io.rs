//! 控制帧和诊断在缓冲增长前受限，缺少换行也不能绕过字节上限。
use tokio::io::AsyncReadExt;
/// 收集 `stream` 到 EOF，分配始终受 `maximum` 限制；读取失败或超限返回具体原因。
pub(super) async fn bounded_output(
    mut stream: impl tokio::io::AsyncRead + Unpin,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let size = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("辅助进程输出读取失败：{error}"))?;
        if size == 0 {
            return Ok(bytes);
        }
        if bytes.len() + size > maximum {
            return Err("辅助进程输出超过资源上限".into());
        }
        bytes.extend_from_slice(&chunk[..size]);
    }
}

/// 从 `reader` 读取一帧，缺少换行也受 `maximum` 字节限制；EOF 返回空帧。
/// 管道读取失败或帧超限返回错误，不等待失效辅助进程继续提交数据。
pub(super) async fn frame_line(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let mut limited = reader.take(maximum as u64 + 1);
    let mut line = Vec::new();
    tokio::io::AsyncBufReadExt::read_until(&mut limited, b'\n', &mut line)
        .await
        .map_err(|error| format!("辅助控制消息读取失败：{error}"))?;
    if line.len() > maximum {
        return Err("辅助控制消息超过字节上限".into());
    }
    Ok(line)
}
