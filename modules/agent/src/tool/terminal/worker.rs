//! 进程观察任务独立于一次工具等待，退出与停止都经过同一条回收路径。

use super::{
    backend::{OwnedChild, Started},
    contract::TerminalStatus,
    io::{Reader, TextDecoder, Writer},
    process::{Interrupt, Process, State},
};
use nix::{errno::Errno, sys::signal::Signal};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinSet,
    time::Instant,
};

/// 后台任务的资源所有者；运行时关闭或任务展开失败也必须提交明确终态。
struct Worker {
    process: Arc<Process>,
    started: Started,
    writer: Arc<Mutex<Option<Writer>>>,
    readers: JoinSet<Result<(), String>>,
}

pub(super) fn run(
    process: Arc<Process>,
    started: Started,
    writer: Arc<Mutex<Option<Writer>>>,
    controls: mpsc::Receiver<Interrupt>,
    expires: Option<Instant>,
) -> impl Future<Output = ()> + Send {
    // 守卫在创建 future 时就生效，覆盖观察任务一次都未获得调度便被取消的情况。
    let worker = Worker {
        process,
        started,
        writer,
        readers: JoinSet::new(),
    };
    async move { worker.complete(controls, expires).await }
}

impl Worker {
    async fn complete(mut self, mut controls: mpsc::Receiver<Interrupt>, expires: Option<Instant>) {
        let Self {
            process,
            started,
            writer,
            readers,
        } = &mut self;
        for reader in started.readers.drain(..) {
            readers.spawn(read_output(reader, process.state.clone(), process.tty));
        }
        let outcome = observe(&mut started.child, process, &mut controls, readers, expires).await;
        process.input_closed.cancel();
        writer.lock().await.take();
        let mut errors = Vec::new();
        let (mut status, exit_code, signal) = match outcome {
            Ok(result) => result,
            Err(error) => {
                errors.push(error);
                (TerminalStatus::Failed, None, None)
            }
        };
        if let Err(error) = started.child.reap() {
            errors.push(error);
        }
        errors.extend(drain_output(readers).await);
        if let Err(error) = started.launch.cleanup() {
            errors.push(error);
        }
        let error = if errors.is_empty() {
            None
        } else {
            status = TerminalStatus::Failed;
            Some(errors.join("；"))
        };
        process.state.finish(status, exit_code, signal, error);
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if self.process.state.info().status != TerminalStatus::Running {
            return;
        }
        self.process.input_closed.cancel();
        self.readers.abort_all();
        let mut errors = vec!["终端观察任务意外中断，输出可能不完整".to_owned()];
        if let Err(error) = self.started.child.reap() {
            errors.push(error);
        }
        if let Err(error) = self.started.launch.cleanup() {
            errors.push(error);
        }
        self.process
            .state
            .finish(TerminalStatus::Failed, None, None, Some(errors.join("；")));
    }
}

/// 主进程退出后限时收尾；管道被遗留后代持有时必须报告不完整输出。
async fn drain_output(readers: &mut JoinSet<Result<(), String>>) -> Vec<String> {
    let mut errors = Vec::new();
    let drain = async {
        while let Some(result) = readers.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => errors.push(error),
                Err(error) => errors.push(format!("终端输出任务失败：{error}")),
            }
        }
    };
    if tokio::time::timeout(Duration::from_secs(1), drain)
        .await
        .is_err()
    {
        errors.push("进程退出后输出管道仍未关闭；已停止读取，输出可能不完整".into());
        readers.abort_all();
        while let Some(result) = readers.join_next().await {
            match result {
                Ok(Err(error)) => errors.push(error),
                Err(error) if !error.is_cancelled() => {
                    errors.push(format!("终端输出任务退出失败：{error}"));
                }
                _ => {}
            }
        }
    }
    errors
}

async fn observe(
    child: &mut OwnedChild,
    process: &Process,
    controls: &mut mpsc::Receiver<Interrupt>,
    readers: &mut JoinSet<Result<(), String>>,
    expires: Option<Instant>,
) -> Result<(TerminalStatus, Option<i32>, Option<String>), String> {
    // 先订阅再检查，覆盖“子进程已退出”和“检查后立即退出”两个时序，空闲时无需轮询。
    let mut exits = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())
        .map_err(|e| format!("终端退出通知注册失败：{e}"))?;
    let mut termination = None;
    let mut kill_at = None;
    loop {
        if let Some(status) = child.poll()? {
            let code = status.exit_status();
            let signal = status.terminating_signal().map(|raw| {
                Signal::try_from(raw)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|_| raw.to_string())
            });
            if code.is_none() && signal.is_none() {
                return Err(format!("终端返回意外退出状态：{status:?}"));
            }
            return Ok((termination.unwrap_or(TerminalStatus::Exited), code, signal));
        }
        if termination.is_none() {
            if process.stop.is_cancelled() {
                termination = Some(TerminalStatus::Stopped);
            } else if expires.is_some_and(|deadline| Instant::now() >= deadline) {
                termination = Some(TerminalStatus::TimedOut);
            }
            if termination.is_some() {
                process.input_closed.cancel();
                child.signal(Signal::SIGTERM)?;
                kill_at = Some(Instant::now() + Duration::from_millis(500));
            }
        }
        if kill_at.is_some_and(|deadline| Instant::now() >= deadline) {
            child.signal(Signal::SIGKILL)?;
            kill_at = None;
        }
        let deadline = if termination.is_none() {
            expires
        } else {
            kill_at
        };
        tokio::select! {
            signal = exits.recv() => { if signal.is_none() { return Err("终端退出通知通道已关闭".into()); } }
            _ = wait_deadline(deadline) => {}
            _ = process.stop.cancelled(), if termination.is_none() => {}
            Some(result) = readers.join_next(), if !readers.is_empty() => {
                // 读取失败必须立即进入清理路径，不能让子进程永远阻塞在无人读取的管道上。
                result.map_err(|e| format!("终端输出任务失败：{e}"))??;
            }
            Some(control) = controls.recv() => {
                if !control.reply.is_closed() {
                    let result = if termination.is_none() { child.signal(Signal::SIGINT) } else { Err("终端正在停止".into()) };
                    // 接收方取消等待时，已发送的中断仍然有效，不重复发送信号。
                    let _ = control.reply.send(result);
                }
            }
        }
    }
}

async fn wait_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

async fn read_output(mut reader: Reader, state: Arc<State>, tty: bool) -> Result<(), String> {
    let mut bytes = [0; 8192];
    let mut decoder = TextDecoder::new();
    loop {
        let count = match reader.read(&mut bytes).await {
            Ok(count) => count,
            // Linux PTY 在最后一个 slave 关闭后以 EIO 表示 EOF。
            Err(error) if tty && error.raw_os_error() == Some(Errno::EIO as i32) => 0,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("终端输出读取失败：{error}")),
        };
        state.push(&decoder.decode(&bytes[..count], count == 0));
        if count == 0 {
            return Ok(());
        }
        // stdout 洪水也必须给取消、超时和其他终端留下调度机会。
        tokio::task::yield_now().await;
    }
}
