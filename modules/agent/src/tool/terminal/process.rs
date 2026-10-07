use super::{
    buffer::OutputBuffer,
    contract::{
        BUFFER_CHARS, TerminalBytesPage, TerminalInfo, TerminalObservation, TerminalOutputPage,
        TerminalSize, TerminalStatus, TerminalStream,
    },
    io::Writer,
    journal::Journal,
};
use crate::CancellationToken;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{Mutex as AsyncMutex, mpsc, oneshot, watch},
    time::Instant,
};

/// 进程的可观察状态与增量输出同锁提交，避免“已退出但丢失最后输出”的竞态。
pub(super) struct State {
    data: Mutex<Data>,
    updates: watch::Sender<Option<TerminalInfo>>,
    journal: AsyncMutex<Journal>,
}

/// 已解码的增量文本与终态一起提交；读取后才允许容量回收。
struct Data {
    buffer: OutputBuffer,
    info: TerminalInfo,
    observed_end: bool,
    subscriptions: usize,
}

impl State {
    pub(super) fn new(id: String, journal: Journal) -> Self {
        Self {
            data: Mutex::new(Data {
                buffer: OutputBuffer::new(BUFFER_CHARS),
                info: TerminalInfo {
                    session_id: id,
                    status: TerminalStatus::Running,
                    exit_code: None,
                    signal: None,
                    error: None,
                },
                observed_end: false,
                subscriptions: 0,
            }),
            updates: watch::channel(None).0,
            journal: AsyncMutex::new(journal),
        }
    }

    pub(super) async fn push(
        &self,
        stream: TerminalStream,
        raw: &[u8],
        text: &str,
    ) -> Result<(), String> {
        let mut journal = self.journal.lock().await;
        journal.append(stream, raw, text).await?;
        self.data
            .lock()
            .expect("终端输出锁被污染")
            .buffer
            .push(text);
        self.updates.send_modify(|_| {});
        Ok(())
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<Option<TerminalInfo>> {
        self.data.lock().expect("终端输出锁被污染").subscriptions += 1;
        self.updates.subscribe()
    }

    pub(super) fn unsubscribe(&self) {
        self.data.lock().expect("终端输出锁被污染").subscriptions -= 1;
    }

    pub(super) async fn flush_log(&self) -> Result<(), String> {
        self.journal.lock().await.flush().await
    }

    pub(super) async fn read(
        &self,
        offset: u64,
        max_chars: usize,
    ) -> Result<TerminalOutputPage, String> {
        let mut journal = self.journal.lock().await;
        let (output, total_bytes) = journal.read(offset, max_chars).await?;
        let next_offset = offset + output.len() as u64;
        let mut data = self.data.lock().expect("终端输出锁被污染");
        if data.info.status != TerminalStatus::Running && next_offset == total_bytes {
            data.observed_end = true;
        }
        Ok(TerminalOutputPage {
            process: data.info.clone(),
            output,
            offset,
            next_offset,
            total_bytes,
            has_more: next_offset < total_bytes,
        })
    }

    pub(super) async fn read_bytes(
        &self,
        offset: u64,
        max_bytes: usize,
    ) -> Result<TerminalBytesPage, String> {
        let mut journal = self.journal.lock().await;
        let (chunks, total_bytes) = journal.read_bytes(offset, max_bytes).await?;
        let next_offset = chunks.last().map_or(offset, |chunk| chunk.next_offset);
        let mut data = self.data.lock().expect("终端输出锁被污染");
        if data.info.status != TerminalStatus::Running && next_offset == total_bytes {
            data.observed_end = true;
        }
        Ok(TerminalBytesPage {
            process: data.info.clone(),
            chunks,
            offset,
            next_offset,
            total_bytes,
            has_more: next_offset < total_bytes,
        })
    }

    pub(super) fn finish(
        &self,
        status: TerminalStatus,
        code: Option<i32>,
        signal: Option<String>,
        error: Option<String>,
    ) {
        let mut data = self.data.lock().expect("终端输出锁被污染");
        data.info.status = status;
        data.info.exit_code = code;
        data.info.signal = signal;
        data.info.error = error;
        // 终态独立保存在通知通道中，日志被会话回收后订阅者仍能核实真实退出结果。
        self.updates.send_replace(Some(data.info.clone()));
    }

    pub(super) fn info(&self) -> TerminalInfo {
        self.data.lock().expect("终端输出锁被污染").info.clone()
    }

    pub(super) fn can_prune(&self) -> bool {
        let data = self.data.lock().expect("终端输出锁被污染");
        data.observed_end && data.subscriptions == 0
    }

    pub(super) async fn wait(&self, duration: Duration) {
        let deadline = Instant::now() + duration;
        let mut updates = self.updates.subscribe();
        while self.info().status == TerminalStatus::Running {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                result = updates.changed() => { if result.is_err() { break; } }
            }
        }
    }

    pub(super) fn take(&self, max_chars: usize) -> TerminalObservation {
        let mut data = self.data.lock().expect("终端输出锁被污染");
        let (output, omitted_chars) = data.buffer.take(max_chars);
        if data.info.status != TerminalStatus::Running {
            data.observed_end = true;
        }
        TerminalObservation {
            process: data.info.clone(),
            output,
            truncated: omitted_chars > 0,
            omitted_chars,
        }
    }
}

/// 控制操作统一交给持有进程身份与 PTY 句柄的后台任务，回传实际系统调用结果。
pub(super) enum Control {
    Interrupt {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Resize {
        size: TerminalSize,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

/// 后台任务只引用进程，不引用 AgentSession；最后一个会话所有者释放时可触发停止。
pub(super) struct Process {
    pub(super) state: Arc<State>,
    pub(super) command: String,
    pub(super) workdir: PathBuf,
    pub(super) tty: bool,
    pub(super) piped_stdin: bool,
    pub(super) stop: CancellationToken,
    // 初始化是整体操作；交互 shell 可忽略 TERM，取消采集时直接结束整个操作。
    pub(super) stop_immediately: bool,
    pub(super) input_closed: CancellationToken,
    // 输入句柄由观察任务持有；任务被中断后会话只保留状态，不延长 PTY 的生命周期。
    pub(super) writer: Weak<AsyncMutex<Option<Writer>>>,
    pub(super) interaction: AsyncMutex<()>,
    pub(super) controls: mpsc::Sender<Control>,
    pub(super) owner: super::sandbox::Identity,
}

impl Process {
    pub(super) async fn input(&self, input: &str, close: bool) -> Result<(), String> {
        // 仅保留旧文本入口的 Ctrl-C 约定；原始输入入口永远不把字节解释成信号。
        if !self.tty && !self.piped_stdin && input == "\u{3}" {
            return self.interrupt().await;
        }
        self.input_bytes(input.as_bytes(), close).await
    }

    pub(super) async fn input_bytes(&self, input: &[u8], close: bool) -> Result<(), String> {
        if close && self.tty {
            return Err("PTY 不支持半关闭输入，请使用终端控制字符或 stop".into());
        }
        if input.is_empty() && !close {
            return Ok(());
        }
        if close && input.is_empty() && (self.input_closed.is_cancelled() || !self.piped_stdin) {
            return Ok(());
        }
        if self.input_closed.is_cancelled() {
            return Err("终端输入已关闭或进程已退出，不能继续输入".into());
        }
        if !self.tty && !self.piped_stdin {
            return Err("stdin 已关闭；交互输入需要在 exec 时设置 stdin=true 或 tty=true".into());
        }
        let writer = self.writer.upgrade().ok_or("终端 stdin 已关闭")?;
        let mut writer = writer.lock().await;
        let pipe = writer.as_mut().ok_or("终端 stdin 已关闭")?;
        tokio::select! {
            biased;
            _ = self.input_closed.cancelled() => Err("终端已退出，输入可能只发送了一部分".into()),
            _ = self.stop.cancelled() => Err("终端正在停止，输入可能只发送了一部分".into()),
            result = pipe.write(input) => result.map_err(|e| format!("终端输入失败，可能已发送部分内容：{e}")),
        }?;
        if close {
            writer.take();
            self.input_closed.cancel();
        }
        Ok(())
    }

    pub(super) async fn interrupt(&self) -> Result<(), String> {
        let (reply, result) = oneshot::channel();
        self.controls
            .send(Control::Interrupt { reply })
            .await
            .map_err(|_| "终端已退出，无法中断")?;
        result.await.map_err(|_| "终端中断请求未完成")?
    }

    pub(super) async fn resize(&self, size: TerminalSize) -> Result<(), String> {
        if !self.tty {
            return Err("普通管道不支持终端尺寸调整".into());
        }
        let (reply, result) = oneshot::channel();
        self.controls
            .send(Control::Resize { size, reply })
            .await
            .map_err(|_| "终端已退出，无法调整尺寸")?;
        result.await.map_err(|_| "终端尺寸调整请求未完成")?
    }
}
