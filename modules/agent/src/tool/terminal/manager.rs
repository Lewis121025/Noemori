use super::{
    backend,
    contract::{MAX_PROCESSES, TerminalObservation, TerminalStatus, TerminalSummary},
    process::{Process, State},
    sandbox::Policy,
    worker,
};
use crate::CancellationToken;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, mpsc};

/// 会话关闭和进程登记同锁处理；已确认读取完的终态才能被容量回收。
#[derive(Default)]
struct Store {
    closed: bool,
    processes: BTreeMap<String, Arc<Process>>,
}

/// 所有入口在同一会话资源表下校验归属，禁止根据模型输入访问全局进程。
#[derive(Default)]
pub(crate) struct Manager {
    store: Mutex<Store>,
}

impl Manager {
    pub(super) fn spawn(
        &self,
        shell: &Path,
        cwd: &Path,
        cmd: &str,
        tty: bool,
        timeout: Option<Duration>,
        policy: &Policy,
    ) -> Result<Arc<Process>, String> {
        let mut store = self.store.lock().expect("终端资源锁被污染");
        if store.closed {
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
        // 从真实启动开始计时，宿主忙碌导致观察任务延迟调度不能延长命令预算。
        let expires = timeout.map(|timeout| tokio::time::Instant::now() + timeout);
        let mut started = backend::spawn(shell, cwd, cmd, tty, policy)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let (interrupt, controls) = mpsc::channel(8);
        let writer = Arc::new(AsyncMutex::new(started.writer.take()));
        let process = Arc::new(Process {
            state: Arc::new(State::new(id.clone())),
            command: cmd.chars().take(256).collect(),
            workdir: cwd.to_owned(),
            tty,
            stop: CancellationToken::new(),
            input_closed: CancellationToken::new(),
            writer: Arc::downgrade(&writer),
            interaction: AsyncMutex::new(()),
            interrupt,
            permissions: policy.permissions().cloned(),
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
        if store.closed {
            return Err("终端会话已关闭".into());
        }
        let process = store
            .processes
            .get(id)
            .cloned()
            .ok_or("此会话中不存在该终端，可能已被回收；请用 list 查询")?;
        if process.permissions.as_ref() != policy.permissions() {
            return Err(
                "终端的启动权限与当前工具不一致，拒绝复用；请创建新的受限终端或由宿主关闭旧会话"
                    .into(),
            );
        }
        Ok(process)
    }

    pub(super) fn list(&self, policy: &Policy) -> Result<Vec<TerminalSummary>, String> {
        let store = self.store.lock().expect("终端资源锁被污染");
        if store.closed {
            return Err("终端会话已关闭".into());
        }
        Ok(store
            .processes
            .values()
            .filter(|p| p.permissions.as_ref() == policy.permissions())
            .map(|p| TerminalSummary {
                process: p.state.info(),
                command: p.command.clone(),
                workdir: p.workdir.to_string_lossy().into_owned(),
                tty: p.tty,
            })
            .collect())
    }

    pub(super) async fn interact(
        &self,
        id: &str,
        input: &str,
        wait: Duration,
        max_chars: usize,
        policy: &Policy,
    ) -> Result<TerminalObservation, String> {
        let process = self.get(id, policy)?;
        let _interaction = process.interaction.lock().await;
        process.input(input).await?;
        process.state.wait(wait).await;
        Ok(process.state.take(max_chars))
    }

    pub(super) async fn stop(
        &self,
        id: &str,
        max_chars: usize,
        policy: &Policy,
    ) -> Result<TerminalObservation, String> {
        let process = self.get(id, policy)?;
        // 停止信号不等待交互锁；即使另一次调用正等输出或写满 stdin，也能终止。
        process.stop.cancel();
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

    pub(crate) async fn close(&self) -> Result<(), String> {
        let processes = {
            let mut store = self.store.lock().expect("终端资源锁被污染");
            store.closed = true;
            let processes: Vec<_> = store.processes.values().cloned().collect();
            for process in &processes {
                process.stop.cancel();
            }
            processes
        };
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
}

impl Drop for Manager {
    fn drop(&mut self) {
        let store = self.store.get_mut().expect("终端资源锁被污染");
        for process in store.processes.values() {
            process.stop.cancel();
        }
    }
}
