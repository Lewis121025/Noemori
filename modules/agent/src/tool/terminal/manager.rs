use super::{
    backend,
    contract::{
        MAX_PROCESSES, TerminalBytesPage, TerminalLogLimits, TerminalObservation,
        TerminalOutputPage, TerminalSize, TerminalStatus, TerminalSummary,
    },
    journal::{Journal, LogBudget},
    process::{Process, State},
    sandbox::Policy,
    shell::{Initialization, Invocation},
    worker,
};
use crate::CancellationToken;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, mpsc, watch};

/// 会话关闭和进程登记同锁处理；已确认读取完的终态才能被容量回收。
#[derive(Default)]
struct Store {
    // None 表示开放；一旦开始关闭，所有等待者共享唯一的后台清理结果。
    close: Option<watch::Receiver<Option<Result<(), String>>>>,
    processes: BTreeMap<String, Arc<Process>>,
}

/// 所有入口在同一会话资源表下校验归属，禁止根据模型输入访问全局进程。
#[derive(Default)]
pub(crate) struct Manager {
    store: Mutex<Store>,
    log_budget: Arc<LogBudget>,
}

/// 实际启动参数与权限；进程归属另由发起工具的基础权限绑定，审批不会扩大其他命令。
pub(super) struct Command<'a> {
    pub(super) shell: Invocation<'a>,
    pub(super) cwd: &'a Path,
    pub(super) io: backend::IoMode,
    pub(super) timeout: Option<Duration>,
    pub(super) policy: &'a Policy,
    pub(super) network_session: &'a Arc<super::NetworkSession>,
    pub(super) call_id: &'a str,
    pub(super) observer: Option<Arc<dyn super::TerminalObserver>>,
    pub(super) ingress: &'a Arc<super::network::IngressRuntime>,
}

impl Manager {
    pub(crate) fn new(limits: TerminalLogLimits) -> Self {
        Self {
            store: Mutex::new(Store::default()),
            log_budget: Arc::new(LogBudget::new(limits)),
        }
    }

    pub(super) fn spawn(
        &self,
        command: Command<'_>,
        owner: &Policy,
    ) -> Result<Arc<Process>, String> {
        let Command {
            shell,
            cwd,
            io,
            timeout,
            policy,
            network_session,
            call_id,
            observer,
            ingress,
        } = command;
        let mut store = self.store.lock().expect("终端资源锁被污染");
        if store.close.is_some() {
            return Err("终端会话已关闭".into());
        }
        if store.processes.len() >= MAX_PROCESSES {
            let old = store
                .processes
                .iter()
                .find(|(_, p)| Arc::strong_count(p) == 1 && p.state.can_prune())
                .map(|(id, _)| id.clone());
            if let Some(old) = old {
                store.processes.remove(&old);
            } else {
                return Err(format!(
                    "会话已达到 {MAX_PROCESSES} 个终端的上限；请先停止不需要的进程并读取其最终输出"
                ));
            }
        }
        let journal = Journal::new(policy.runtime(), self.log_budget.clone())?;
        // 从真实启动开始计时，宿主忙碌导致观察任务延迟调度不能延长命令预算。
        let expires = timeout.map(|timeout| tokio::time::Instant::now() + timeout);
        let id = uuid::Uuid::new_v4().simple().to_string();
        let stop = CancellationToken::new();
        let network = matches!(
            policy.permissions().map(|permissions| &permissions.network),
            Some(super::NetworkAccess::Managed(_))
        )
        .then(|| super::network::ProcessNetwork {
            session: network_session.clone(),
            terminal_id: id.clone(),
            call_id: call_id.into(),
            command: shell.command.into(),
            workdir: cwd.to_owned(),
            stop: stop.clone(),
            observer,
            ingress: ingress.clone(),
        });
        let mut started = backend::spawn(shell, cwd, io, policy, network.as_ref())?;
        let (control, controls) = mpsc::channel(8);
        let writer = Arc::new(AsyncMutex::new(started.writer.take()));
        let process = Arc::new(Process {
            state: Arc::new(State::new(id.clone(), journal)),
            command: shell.command.chars().take(256).collect(),
            workdir: cwd.to_owned(),
            tty: matches!(io, backend::IoMode::Pty(_)),
            piped_stdin: matches!(io, backend::IoMode::Pipe { stdin: true }),
            stop,
            stop_immediately: matches!(shell.initialization, Initialization::Capture { .. }),
            input_closed: CancellationToken::new(),
            writer: Arc::downgrade(&writer),
            interaction: AsyncMutex::new(()),
            controls: control,
            owner: owner.identity(),
        });
        // 启动、登记、交接后台所有权之间没有 await；取消不会留下无人负责的子进程。
        store.processes.insert(id, process.clone());
        tokio::spawn(worker::run(
            process.clone(),
            started,
            writer,
            controls,
            expires,
        ));
        Ok(process)
    }

    fn get(&self, id: &str, policy: &Policy) -> Result<Arc<Process>, String> {
        let store = self.store.lock().expect("终端资源锁被污染");
        if store.close.is_some() {
            return Err("终端会话已关闭".into());
        }
        let process = store
            .processes
            .get(id)
            .cloned()
            .ok_or("此会话中不存在该终端，可能已被回收；请用 list 查询")?;
        if !policy.matches(&process.owner) {
            return Err(
                "终端的启动权限或环境快照与当前工具不一致，拒绝复用；请创建新的受限终端或由宿主关闭旧会话"
                    .into(),
            );
        }
        Ok(process)
    }

    pub(super) fn subscribe(
        &self,
        id: &str,
        offset: u64,
        policy: &Policy,
    ) -> Result<super::TerminalSubscription, String> {
        let process = self.get(id, policy)?;
        Ok(super::TerminalSubscription::new(&process.state, offset))
    }

    /// 宿主只发送输入；保留模型的输出游标，Writer 的锁负责与模型输入排序。
    pub(super) async fn send_input(
        &self,
        id: &str,
        input: &[u8],
        close_stdin: bool,
        policy: &Policy,
    ) -> Result<(), String> {
        let process = self.get(id, policy)?;
        process.input_bytes(input, close_stdin).await
    }

    pub(super) fn list(&self, policy: &Policy) -> Result<Vec<TerminalSummary>, String> {
        let store = self.store.lock().expect("终端资源锁被污染");
        if store.close.is_some() {
            return Err("终端会话已关闭".into());
        }
        Ok(store
            .processes
            .values()
            .filter(|p| policy.matches(&p.owner))
            .map(|p| TerminalSummary {
                process: p.state.info(),
                command: p.command.clone(),
                workdir: p.workdir.to_string_lossy().into_owned(),
                tty: p.tty,
                stdin_open: (p.tty || p.piped_stdin) && !p.input_closed.is_cancelled(),
            })
            .collect())
    }

    pub(super) async fn interact(
        &self,
        id: &str,
        input: &str,
        close_stdin: bool,
        wait: Duration,
        max_chars: usize,
        policy: &Policy,
    ) -> Result<TerminalObservation, String> {
        let process = self.get(id, policy)?;
        let _interaction = process.interaction.lock().await;
        process.input(input, close_stdin).await?;
        process.state.wait(wait).await;
        Ok(process.state.take(max_chars))
    }

    pub(super) async fn write(
        &self,
        id: &str,
        input: &[u8],
        close_stdin: bool,
        wait: Duration,
        max_chars: usize,
        policy: &Policy,
    ) -> Result<TerminalObservation, String> {
        let process = self.get(id, policy)?;
        let _interaction = process.interaction.lock().await;
        process.input_bytes(input, close_stdin).await?;
        process.state.wait(wait).await;
        Ok(process.state.take(max_chars))
    }

    pub(super) async fn resize(
        &self,
        id: &str,
        size: TerminalSize,
        policy: &Policy,
    ) -> Result<(), String> {
        self.get(id, policy)?.resize(size).await
    }

    pub(super) async fn interrupt(&self, id: &str, policy: &Policy) -> Result<(), String> {
        self.get(id, policy)?.interrupt().await
    }

    pub(super) async fn read(
        &self,
        id: &str,
        offset: u64,
        max_chars: usize,
        policy: &Policy,
    ) -> Result<TerminalOutputPage, String> {
        self.get(id, policy)?.state.read(offset, max_chars).await
    }

    pub(super) async fn read_bytes(
        &self,
        id: &str,
        offset: u64,
        max_bytes: usize,
        policy: &Policy,
    ) -> Result<TerminalBytesPage, String> {
        self.get(id, policy)?
            .state
            .read_bytes(offset, max_bytes)
            .await
    }

    pub(super) fn release(&self, id: &str, policy: &Policy) -> Result<(), String> {
        let process = self.get(id, policy)?;
        if process.state.info().status == TerminalStatus::Running {
            return Err("运行中的终端不能释放，请先 stop".into());
        }
        self.store
            .lock()
            .expect("终端资源锁被污染")
            .processes
            .remove(id);
        Ok(())
    }

    pub(super) async fn stop(
        &self,
        id: &str,
        max_chars: usize,
        policy: &Policy,
    ) -> Result<TerminalObservation, String> {
        let process = self.stopping(id, policy)?;
        process.state.wait(Duration::from_secs(5)).await;
        if process.state.info().status == TerminalStatus::Running {
            return Err(
                "终端已收到停止请求，但未能在 5 秒内确认退出；后台仍负责清理，可继续 list 查询"
                    .into(),
            );
        }
        let _interaction = process.interaction.lock().await;
        Ok(process.state.take(max_chars))
    }

    /// 宿主排队停止并读取当前状态；终态通过独立订阅交付，不消费模型输出。
    pub(super) fn request_stop(
        &self,
        id: &str,
        policy: &Policy,
    ) -> Result<super::TerminalInfo, String> {
        Ok(self.stopping(id, policy)?.state.info())
    }

    fn stopping(&self, id: &str, policy: &Policy) -> Result<Arc<Process>, String> {
        let process = self.get(id, policy)?;
        // 停止信号不等待交互锁；即使另一次调用正等输出或写满 stdin，也能终止。
        process.stop.cancel();
        Ok(process)
    }

    pub(crate) async fn close(&self) -> Result<(), String> {
        let mut done = {
            let mut store = self.store.lock().expect("终端资源锁被污染");
            if let Some(done) = &store.close {
                done.clone()
            } else {
                let processes: Vec<_> =
                    std::mem::take(&mut store.processes).into_values().collect();
                for process in &processes {
                    process.stop.cancel();
                }
                let (sender, done) = watch::channel(None);
                // 清理拥有进程记录；调用方取消等待或保留已关闭会话都不会延长日志寿命。
                tokio::spawn(async move {
                    let result = finish_close(&processes).await;
                    drop(processes);
                    sender.send_replace(Some(result));
                });
                store.close = Some(done.clone());
                done
            }
        };
        loop {
            if let Some(result) = done.borrow().clone() {
                return result;
            }
            done.changed()
                .await
                .map_err(|_| "终端会话清理任务意外中断".to_owned())?;
        }
    }
}

async fn finish_close(processes: &[Arc<Process>]) -> Result<(), String> {
    let results = futures::future::join_all(processes.iter().map(|process| async {
        process.state.wait(Duration::from_secs(5)).await;
        let info = process.state.info();
        if info.status == TerminalStatus::Running {
            Some("终端会话清理未能在 5 秒内确认完成".to_owned())
        } else {
            info.error
        }
    }))
    .await;
    let errors: Vec<_> = results.into_iter().flatten().collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        let store = self.store.get_mut().expect("终端资源锁被污染");
        for process in store.processes.values() {
            process.stop.cancel();
        }
    }
}

#[cfg(test)]
#[path = "../../../../../test/agent/terminal/unit/lifecycle.rs"]
mod tests;
