//! 非阻塞管道与 PTY I/O；不为长时间进程占用阻塞线程池。

use std::{io, os::fd::OwnedFd};
use tokio::io::unix::AsyncFd;

/// 独占读取描述符，交由 Tokio 就绪通知驱动，释放时关闭对应句柄。
pub(super) struct Reader(AsyncFd<OwnedFd>);
/// 独占 PTY 输入描述符，支持在写入背压期间取消等待。
pub(super) struct Writer(AsyncFd<OwnedFd>);

fn descriptor(fd: OwnedFd) -> Result<AsyncFd<OwnedFd>, String> {
    let flags = rustix::fs::fcntl_getfl(&fd).map_err(|e| format!("终端无法读取 I/O 标志：{e}"))?;
    rustix::fs::fcntl_setfl(&fd, flags | rustix::fs::OFlags::NONBLOCK)
        .map_err(|e| format!("终端无法设置非阻塞 I/O：{e}"))?;
    AsyncFd::new(fd).map_err(|e| format!("终端 I/O 注册失败：{e}"))
}

impl Reader {
    pub(super) fn new(fd: OwnedFd) -> Result<Self, String> {
        descriptor(fd).map(Self)
    }

    pub(super) async fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut ready = self.0.readable().await?;
            match ready
                .try_io(|fd| rustix::io::read(fd.get_ref(), &mut *buffer).map_err(io::Error::from))
            {
                Ok(result) => return result,
                Err(_) => continue,
            }
        }
    }
}

impl Writer {
    pub(super) fn new(fd: OwnedFd) -> Result<Self, String> {
        descriptor(fd).map(Self)
    }

    pub(super) async fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let mut ready = self.0.writable().await?;
            match ready
                .try_io(|fd| rustix::io::write(fd.get_ref(), remaining).map_err(io::Error::from))
            {
                Ok(Ok(0)) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(Ok(count)) => remaining = &remaining[count..],
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(Err(error)) => return Err(error),
                Err(_) => continue,
            }
        }
        Ok(())
    }
}

/// 按流解码 UTF-8；跨读取分片的字符只有在完整或 EOF 时才提交。
pub(super) struct TextDecoder(encoding_rs::Decoder);

impl TextDecoder {
    pub(super) fn new() -> Self {
        Self(encoding_rs::UTF_8.new_decoder_without_bom_handling())
    }

    pub(super) fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        let mut text = String::with_capacity(bytes.len() * 3 + 4);
        let (result, read, _) = self.0.decode_to_string(bytes, &mut text, last);
        debug_assert_eq!(result, encoding_rs::CoderResult::InputEmpty);
        debug_assert_eq!(read, bytes.len());
        text
    }
}
