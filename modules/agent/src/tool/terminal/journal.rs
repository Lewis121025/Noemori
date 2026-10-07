use super::{
    contract::{TerminalLogLimits, TerminalOutputChunk, TerminalStream},
    sandbox::Root,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    io::SeekFrom,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter};

const HEADER_BYTES: usize = 9;
const INDEX_INTERVAL: u64 = 64 * 1024;
const MAX_PAGE_CHUNKS: usize = 256;

/// 会话统一核算磁盘记录，而非 Base64 或内存预览；一次失败写入的预留空间也保留到释放。
pub(super) struct LogBudget {
    used: AtomicU64,
    pub(super) limits: TerminalLogLimits,
}

impl LogBudget {
    pub(super) fn new(limits: TerminalLogLimits) -> Self {
        Self {
            used: AtomicU64::new(0),
            limits,
        }
    }

    fn reserve(&self, bytes: u64) -> Result<(), String> {
        let mut used = self.used.load(Ordering::Relaxed);
        loop {
            let total = used
                .checked_add(bytes)
                .ok_or_else(|| "会话日志字节计数溢出；命令已停止".to_owned())?;
            if self.limits.session_bytes.is_some_and(|limit| total > limit) {
                return Err(limit_error("会话", self.limits.session_bytes));
            }
            match self
                .used
                .compare_exchange_weak(used, total, Ordering::Relaxed, Ordering::Relaxed)
            {
                Ok(_) => return Ok(()),
                Err(current) => used = current,
            }
        }
    }

    fn release(&self, bytes: u64) {
        self.used.fetch_sub(bytes, Ordering::Relaxed);
    }
}

impl Default for LogBudget {
    fn default() -> Self {
        Self::new(TerminalLogLimits::default())
    }
}

fn limit_error(scope: &str, limit: Option<u64>) -> String {
    let limit = limit.expect("只有有界预算才会拒绝预留");
    let capacity = if limit.is_multiple_of(1024 * 1024) {
        format!("{} MiB", limit / (1024 * 1024))
    } else {
        format!("{limit} 字节")
    };
    format!("{scope}日志超过 {capacity} 配额；命令已停止，此前输出仍可回读，请释放已结束的记录")
}

/// 稀疏检查点同时定位原始字节和文本视图，索引规模只随磁盘字节数增长。
#[derive(Clone, Copy, Default)]
struct Position {
    file: u64,
    raw: u64,
    text: u64,
}

/// 单一追加日志保存流来源与原始字节；解码结果仅在与原字节不同的分片中额外保存。
/// 文本和原始读取共享日志，避免为 stdout/stderr、预览和订阅各复制一份完整输出。
pub(super) struct Journal {
    writer: BufWriter<tokio::fs::File>,
    file: tempfile::TempPath,
    position: Position,
    index: Vec<Position>,
    reserved_bytes: u64,
    budget: Arc<LogBudget>,
    interrupted_write: bool,
    _runtime: Arc<Root>,
}

/// 一次系统读取对应一个记录，文本允许为空或在 EOF 时独立补齐解码器的残留字符。
struct Record {
    stream: TerminalStream,
    raw: Vec<u8>,
    text: String,
    stored_bytes: u64,
}

impl Journal {
    pub(super) fn new(runtime: Arc<Root>, budget: Arc<LogBudget>) -> Result<Self, String> {
        let file = tempfile::Builder::new()
            .prefix("output-")
            .tempfile_in(runtime.path())
            .map_err(|e| format!("终端日志创建失败：{e}"))?;
        let (writer, file) = file.into_parts();
        Ok(Self {
            writer: BufWriter::with_capacity(64 * 1024, tokio::fs::File::from_std(writer)),
            file,
            position: Position::default(),
            index: vec![Position::default()],
            reserved_bytes: 0,
            budget,
            interrupted_write: false,
            _runtime: runtime,
        })
    }

    pub(super) async fn append(
        &mut self,
        stream: TerminalStream,
        raw: &[u8],
        text: &str,
    ) -> Result<(), String> {
        if self.interrupted_write {
            return Err("终端日志写入曾中断，拒绝在不完整内容之后继续追加".into());
        }
        if raw.is_empty() && text.is_empty() {
            return Ok(());
        }
        let shared = raw == text.as_bytes();
        let raw_length = u32::try_from(raw.len()).map_err(|_| "终端输出分片过大")?;
        let text_length = u32::try_from(text.len()).map_err(|_| "终端文本分片过大")?;
        let mut encoded =
            Vec::with_capacity(HEADER_BYTES + raw.len() + if shared { 0 } else { text.len() });
        let stream = match stream {
            TerminalStream::Stdout => 0,
            TerminalStream::Stderr => 1,
            TerminalStream::Terminal => 2,
        };
        encoded.push(stream | if shared { 0x80 } else { 0 });
        encoded.extend_from_slice(&raw_length.to_le_bytes());
        encoded.extend_from_slice(&text_length.to_le_bytes());
        encoded.extend_from_slice(raw);
        if !shared {
            encoded.extend_from_slice(text.as_bytes());
        }
        let bytes = encoded.len() as u64;
        let reserved = self
            .reserved_bytes
            .checked_add(bytes)
            .ok_or("终端日志长度溢出")?;
        if self
            .budget
            .limits
            .process_bytes
            .is_some_and(|limit| reserved > limit)
        {
            return Err(limit_error("终端", self.budget.limits.process_bytes));
        }
        self.budget.reserve(bytes)?;
        // 在首次 await 前把预留交给日志所有者；取消写入不会把已落盘的部分当作不存在。
        self.reserved_bytes = reserved;
        self.interrupted_write = true;
        self.writer
            .write_all(&encoded)
            .await
            .map_err(|e| format!("终端日志写入失败，输出可能不完整：{e}"))?;
        self.interrupted_write = false;
        if self.position.file - self.index.last().expect("索引总有初始项").file >= INDEX_INTERVAL
        {
            self.index.push(self.position);
        }
        self.position.file += bytes;
        self.position.raw += u64::from(raw_length);
        self.position.text += u64::from(text_length);
        Ok(())
    }

    pub(super) async fn flush(&mut self) -> Result<(), String> {
        self.writer
            .flush()
            .await
            .map_err(|e| format!("终端日志写入失败：{e}"))
    }

    async fn reader(
        &mut self,
        offset: u64,
        raw: bool,
    ) -> Result<(tokio::fs::File, Position), String> {
        let coordinate = |position: &Position| if raw { position.raw } else { position.text };
        if offset > coordinate(&self.position) {
            return Err("日志游标超过当前输出长度".into());
        }
        self.flush().await?;
        let index = self
            .index
            .partition_point(|position| coordinate(position) <= offset)
            - 1;
        let position = self.index[index];
        // 独立描述符和位置使取消读取与其他订阅都不会改变追加端的状态。
        let mut reader = tokio::fs::File::open(&self.file)
            .await
            .map_err(|e| format!("终端日志读取失败：{e}"))?;
        reader
            .seek(SeekFrom::Start(position.file))
            .await
            .map_err(|e| format!("终端日志定位失败：{e}"))?;
        Ok((reader, position))
    }

    pub(super) async fn read(
        &mut self,
        offset: u64,
        max_chars: usize,
    ) -> Result<(String, u64), String> {
        let (mut reader, mut position) = self.reader(offset, false).await?;
        let mut output = String::new();
        let mut remaining = max_chars;
        while position.file < self.position.file && remaining > 0 {
            let record = Record::read(&mut reader).await?;
            let end = position.text + record.text.len() as u64;
            if end > offset {
                let start = offset.saturating_sub(position.text) as usize;
                let text = record
                    .text
                    .get(start..)
                    .ok_or("日志游标必须位于 UTF-8 字符边界，请使用返回的 next_offset")?;
                let mut characters = text.char_indices();
                let stop = characters
                    .nth(remaining)
                    .map_or(text.len(), |(index, _)| index);
                let text = &text[..stop];
                remaining -= text.chars().count();
                output.push_str(text);
            }
            position.advance(&record);
        }
        Ok((output, self.position.text))
    }

    pub(super) async fn read_bytes(
        &mut self,
        offset: u64,
        max_bytes: usize,
    ) -> Result<(Vec<TerminalOutputChunk>, u64), String> {
        let (mut reader, mut position) = self.reader(offset, true).await?;
        let mut chunks = Vec::new();
        let mut cursor = offset;
        let mut remaining = max_bytes;
        while position.file < self.position.file && remaining > 0 && chunks.len() < MAX_PAGE_CHUNKS
        {
            let record = Record::read(&mut reader).await?;
            let end = position.raw + record.raw.len() as u64;
            if end > cursor {
                let start = cursor.saturating_sub(position.raw) as usize;
                let count = remaining.min(record.raw.len() - start);
                chunks.push(TerminalOutputChunk {
                    stream: record.stream,
                    data_base64: STANDARD.encode(&record.raw[start..start + count]),
                    offset: cursor,
                    next_offset: cursor + count as u64,
                });
                cursor += count as u64;
                remaining -= count;
            }
            position.advance(&record);
        }
        Ok((chunks, self.position.raw))
    }
}

impl Position {
    fn advance(&mut self, record: &Record) {
        self.file += record.stored_bytes;
        self.raw += record.raw.len() as u64;
        self.text += record.text.len() as u64;
    }
}

impl Record {
    async fn read(reader: &mut tokio::fs::File) -> Result<Self, String> {
        let mut header = [0; HEADER_BYTES];
        reader
            .read_exact(&mut header)
            .await
            .map_err(|e| format!("终端日志记录读取失败：{e}"))?;
        let stream = match header[0] & 0x7f {
            0 => TerminalStream::Stdout,
            1 => TerminalStream::Stderr,
            2 => TerminalStream::Terminal,
            _ => return Err("终端日志流标识无效".into()),
        };
        let raw_length =
            u32::from_le_bytes(header[1..5].try_into().expect("固定四字节长度")) as usize;
        let text_length =
            u32::from_le_bytes(header[5..9].try_into().expect("固定四字节长度")) as usize;
        let shared = header[0] & 0x80 != 0;
        // 记录仅来自 8 KiB 的内部读取；校验可防止损坏文件触发无界内存分配。
        if raw_length > 8192 || text_length > 8192 * 3 + 4 || (shared && raw_length != text_length)
        {
            return Err("终端日志记录长度无效".into());
        }
        let mut raw = vec![0; raw_length];
        reader
            .read_exact(&mut raw)
            .await
            .map_err(|e| format!("终端日志原始字节读取失败：{e}"))?;
        let text = if shared {
            raw.clone()
        } else {
            let mut text = vec![0; text_length];
            reader
                .read_exact(&mut text)
                .await
                .map_err(|e| format!("终端日志文本读取失败：{e}"))?;
            text
        };
        let text = String::from_utf8(text).map_err(|e| format!("终端日志文本编码无效：{e}"))?;
        Ok(Self {
            stream,
            raw,
            text,
            stored_bytes: (HEADER_BYTES + raw_length + if shared { 0 } else { text_length }) as u64,
        })
    }
}

impl Drop for Journal {
    fn drop(&mut self) {
        self.budget.release(self.reserved_bytes);
    }
}
