use super::{
    buffer::OutputBuffer,
    contract::{BUFFER_CHARS, TerminalInfo, TerminalObservation, TerminalStatus},
    io::Writer,
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
    updates: watch::Sender<()>,
}

/// 已解码的增量文本与终态一起提交；读取后才允许容量回收。
struct Data {
    buffer: OutputBuffer,
    info: TerminalInfo,
    observed_end: bool,
}

impl State {
    pub(super) fn new(id: String) -> Self {
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
            }),
            updates: watch::channel(()).0,
        }
    }

    pub(super) fn push(&self, text: &str) {
        self.data
            .lock()
            .expect("终端输出锁被污染")
            .buffer
            .push(text);
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
        self.updates.send_replace(());
    }

    pub(super) fn info(&self) -> TerminalInfo {
        self.data.lock().expect("终端输出锁被污染").info.clone()
    }

    pub(super) fn can_prune(&self) -> bool {
        self.data.lock().expect("终端输出锁被污染").observed_end
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

/// 将非 PTY 的 Ctrl-C 请求交给持有进程身份的后台任务，并回传实际信号发送结果。
pub(super) struct Interrupt {
    pub(super) reply: oneshot::Sender<Result<(), String>>,
}

/// 后台任务只引用进程，不引用 AgentSession；最后一个会话所有者释放时可触发停止。
pub(super) struct Process {
    pub(super) state: Arc<State>,
    pub(super) command: String,
    pub(super) workdir: PathBuf,
    pub(super) tty: bool,
    pub(super) stop: CancellationToken,
    pub(super) input_closed: CancellationToken,
    // 输入句柄由观察任务持有；任务被中断后会话只保留状态，不延长 PTY 的生命周期。
    pub(super) writer: Weak<AsyncMutex<Option<Writer>>>,
    pub(super) interaction: AsyncMutex<()>,
    pub(super) interrupt: mpsc::Sender<Interrupt>,
    pub(super) permissions: Option<super::sandbox::Permissions>,
}

impl Process {
    pub(super) async fn input(&self, input: &str) -> Result<(), String> {
        if input.is_empty() {
            return Ok(());
        }
        if self.input_closed.is_cancelled() {
            return Err("终端已退出，不能继续输入".into());
        }
        if !self.tty {
            if input != "\u{3}" {
                return Err("stdin 已关闭；交互输入需要在 exec 时设置 tty=true".into());
            }
            let (reply, result) = oneshot::channel();
            self.interrupt
                .send(Interrupt { reply })
                .await
                .map_err(|_| "终端已退出，无法中断")?;
            return result.await.map_err(|_| "终端中断请求未完成")?;
        }
        let writer = self.writer.upgrade().ok_or("终端 stdin 已关闭")?;
        let mut writer = writer.lock().await;
        let writer = writer.as_mut().ok_or("终端 stdin 已关闭")?;
        tokio::select! {
            biased;
            _ = self.input_closed.cancelled() => Err("终端已退出，输入可能只发送了一部分".into()),
            _ = self.stop.cancelled() => Err("终端正在停止，输入可能只发送了一部分".into()),
            result = writer.write(input.as_bytes()) => result.map_err(|e| format!("终端输入失败，可能已发送部分内容：{e}")),
        }
    }
}
