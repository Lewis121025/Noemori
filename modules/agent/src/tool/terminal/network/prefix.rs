use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// 协议和身份选择读取的字节必须完整交还解析器，不能丢失标头、正文或升级后的预读数据。
pub(super) struct Prefix<S> {
    pub(super) stream: S,
    bytes: Vec<u8>,
    offset: usize,
}

impl<S> Prefix<S> {
    pub(super) fn new(stream: S, bytes: Vec<u8>) -> Self {
        Self {
            stream,
            bytes,
            offset: 0,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefix<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if buffer.remaining() != 0 && self.offset < self.bytes.len() {
            let count = buffer.remaining().min(self.bytes.len() - self.offset);
            buffer.put_slice(&self.bytes[self.offset..self.offset + count]);
            self.offset += count;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.stream).poll_read(context, buffer)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for Prefix<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(context, bytes)
    }
    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(context)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(context)
    }
}
