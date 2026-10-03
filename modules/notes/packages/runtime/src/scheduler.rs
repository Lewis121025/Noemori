//! 入队顺序在调用线程确定；阻塞工作不占 Tokio 调度线程，取消不经过命令通道。

use crate::{Error, OperationControl, Result, State, VaultEvent};
use noemori_vault::{SearchCancellation, Vault};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    sync::{mpsc, oneshot, Semaphore},
    task::JoinSet,
};

pub(crate) type ScopedReadSession = Arc<Mutex<Option<(u64, String, SearchCancellation)>>>;

type Work = Box<dyn FnOnce(&mut State) + Send>;
type Read = Box<dyn FnOnce(Arc<Vault>) + Send>;
enum Command {
    Write(Option<u64>, Work, oneshot::Sender<Result<()>>),
    Read(u64, Read, oneshot::Sender<Result<()>>),
    Shutdown(oneshot::Sender<Result<()>>),
}

/// 一次已入队操作；丢弃接收者不会撤销写入，必须等待真实提交结果。
pub struct Pending<T> {
    done: oneshot::Receiver<Result<()>>,
    result: oneshot::Receiver<T>,
    target: Option<(Arc<AtomicU64>, u64)>,
}

impl<T> Pending<T> {
    /// 等待操作完成；调度故障拒绝，不自动重试。
    /// # Errors
    /// 停机、库代次失效、工作任务异常时返回运行时错误。
    pub async fn wait(self) -> Result<T> {
        self.done
            .await
            .map_err(|_| Error::State("内核任务意外结束，结果未知".into()))??;
        if self
            .target
            .is_some_and(|(current, expected)| current.load(Ordering::Acquire) != expected)
        {
            return Err(Error::State("笔记库已切换，请重试".into()));
        }
        self.result
            .await
            .map_err(|_| Error::State("内核任务没有返回结果".into()))
    }
}

struct Admission {
    sender: mpsc::UnboundedSender<Command>,
    closed: bool,
    controls: Vec<OperationControl>,
}

/// 一个应用实例的命令入口；短临界区只登记请求，不持有磁盘锁。
pub struct Runtime {
    admission: Mutex<Admission>,
    generation: Arc<AtomicU64>,
    failed: Arc<AtomicBool>,
    search: ScopedReadSession,
    model: ScopedReadSession,
    read_cancellation: SearchCancellation,
}

impl Runtime {
    /// 在宿主提供的 Tokio 上启动运行时，不另建线程池；磁盘延迟初始化。
    pub fn new(user_data: PathBuf, notify: impl Fn(VaultEvent) + Send + Sync + 'static) -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        let generation = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(AtomicBool::new(false));
        let search = Arc::new(Mutex::new(None));
        let model = Arc::new(Mutex::new(None));
        let notify: Arc<dyn Fn(VaultEvent) + Send + Sync> = Arc::new(notify);
        let (publisher, publication) = crate::publication::Publisher::start(Arc::clone(&notify));
        let state = State::new(
            user_data,
            Arc::clone(&generation),
            notify,
            Arc::clone(&search),
            Arc::clone(&model),
            publisher,
        );
        tokio::spawn(run(receiver, state, Arc::clone(&failed), publication));
        Self {
            admission: Mutex::new(Admission {
                sender,
                closed: false,
                controls: Vec::new(),
            }),
            generation,
            failed,
            search,
            model,
            read_cancellation: SearchCancellation::default(),
        }
    }

    /// 长时间只读扫描共享停机信号；持久写事务仍必须排空，不借此中断提交。
    pub fn read_cancellation(&self) -> SearchCancellation {
        self.read_cancellation.clone()
    }

    /// 当前库代次用于结果交付复核；只读取原子内存。
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// 顺序提交应用或库变更；`scoped` 为真时绑定进入时的库代次。
    pub fn write<T: Send + 'static>(
        &self,
        scoped: bool,
        operation: impl FnOnce(&mut State) -> T + Send + 'static,
    ) -> Pending<T> {
        let (reply, result) = oneshot::channel();
        let (finished, done) = oneshot::channel();
        let work = Box::new(move |state: &mut State| {
            let _ = reply.send(operation(state));
        });
        self.send(Command::Write(
            scoped.then(|| self.generation()),
            work,
            finished,
        ));
        Pending {
            done,
            result,
            target: None,
        }
    }

    /// 读取在此前写入完成后获取固定库实例；最多四项占用阻塞线程。
    pub fn read<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Arc<Vault>) -> T + Send + 'static,
    ) -> Pending<T> {
        let (reply, result) = oneshot::channel();
        let (finished, done) = oneshot::channel();
        let work = Box::new(move |vault| {
            let _ = reply.send(operation(vault));
        });
        let generation = self.generation();
        self.send(Command::Read(generation, work, finished));
        Pending {
            done,
            result,
            target: Some((Arc::clone(&self.generation), generation)),
        }
    }

    fn send(&self, command: Command) {
        let admission = self
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if admission.closed || self.failed.load(Ordering::Acquire) {
            reject(command, "内核正在关闭或已发生故障");
        } else if let Err(error) = admission.sender.send(command) {
            reject(error.0, "内核调度已停止");
        }
    }

    /// 登记当前操作取消句柄；释放完成项，停机时取消尚未提交的工作。
    pub fn register_control(&self, control: &OperationControl) {
        let mut a = self
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        a.controls.retain(OperationControl::in_use);
        if a.closed {
            let _ = control.cancel();
        } else {
            a.controls.push(control.clone());
        }
    }

    /// 在请求进入时绑定搜索会话；续页不能复活失效的搜索。
    /// # Errors
    /// 已关闭或旧续页返回取消错误。
    pub fn search(&self, id: String, continuation: bool) -> Result<SearchCancellation> {
        let a = self
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if a.closed {
            return Err(Error::State("内核正在关闭".into()));
        }
        session_token(&self.search, self.generation(), id, continuation)
    }

    /// 模型安装有独立会话，普通搜索不会取消正在进行的模型下载或导入。
    /// # Errors
    /// 运行时已关闭，或安装已取消／所属库已改变。
    pub fn model_session(&self, id: String, continuation: bool) -> Result<SearchCancellation> {
        let admission = self
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if admission.closed {
            return Err(Error::State("内核正在关闭".into()));
        }
        session_token(&self.model, self.generation(), id, continuation)
    }

    /// 只取消指定模型安装，不影响当前搜索或已交给库生命周期的后台索引。
    pub fn cancel_model(&self, id: &str) {
        cancel_session(&self.model, Some(id));
    }

    /// 只取消匹配的会话；迟到的取消不影响新搜索。
    pub fn cancel_search(&self, id: &str) {
        cancel_session(&self.search, Some(id));
    }

    /// 同步关闭入口，异步等待写入、读取和资源释放；不可强制中止写事务。
    /// # Errors
    /// 调度器故障或资源回收失败时拒绝，不能当作安全停机。
    pub fn shutdown(&self) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        let (reply, received) = oneshot::channel();
        let mut a = self
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        a.closed = true;
        self.read_cancellation.cancel();
        cancel_session(&self.search, None);
        cancel_session(&self.model, None);
        for control in a.controls.drain(..) {
            let _ = control.cancel();
        }
        let sent = a.sender.send(Command::Shutdown(reply));
        async move {
            sent.map_err(|_| Error::State("内核已停止".into()))?;
            received
                .await
                .map_err(|_| Error::State("内核未完成停机".into()))?
        }
    }
}

fn session_token(
    session: &ScopedReadSession,
    generation: u64,
    id: String,
    continuation: bool,
) -> Result<SearchCancellation> {
    let mut slot = session
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((current_generation, current, token)) = &*slot {
        if *current_generation == generation && current == &id {
            return Ok(token.clone());
        }
    }
    if continuation {
        return Err(noemori_vault::Error::SearchCancelled.into());
    }
    let token = SearchCancellation::default();
    if let Some((_, _, previous)) = slot.replace((generation, id, token.clone())) {
        previous.cancel();
    }
    Ok(token)
}

/// 切库、停机或明确取消使用同一释放规则；迟到的任务 ID 不能撤销后发任务。
pub(crate) fn cancel_session(session: &ScopedReadSession, id: Option<&str>) {
    let mut slot = session
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if id.is_none()
        || slot
            .as_ref()
            .is_some_and(|(_, current, _)| Some(current.as_str()) == id)
    {
        if let Some((_, _, token)) = slot.take() {
            token.cancel();
        }
    }
}

fn reject(command: Command, message: &str) {
    let reply = match command {
        Command::Write(_, _, r) | Command::Read(_, _, r) | Command::Shutdown(r) => r,
    };
    let _ = reply.send(Err(Error::State(message.into())));
}

async fn run(
    mut commands: mpsc::UnboundedReceiver<Command>,
    mut state: State,
    failed: Arc<AtomicBool>,
    publication: tokio::task::JoinHandle<()>,
) {
    let permits = Arc::new(Semaphore::new(4));
    let mut reads = JoinSet::new();
    loop {
        let command = tokio::select! {
            command = commands.recv() => command,
            _ = reads.join_next(), if !reads.is_empty() => continue,
        };
        let Some(command) = command else {
            break;
        };
        if failed.load(Ordering::Acquire) && !matches!(command, Command::Shutdown(_)) {
            reject(command, "内核任务异常，禁止重放结果未知的写入");
            continue;
        }
        match command {
            Command::Write(generation, work, reply) => {
                if generation.is_some_and(|g| !state.matches(g)) {
                    let _ = reply.send(Err(Error::State("笔记库已切换，请重试".into())));
                    continue;
                }
                let (next, outcome) = tokio::task::spawn_blocking(move || {
                    let result =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&mut state)));
                    (state, result.is_ok())
                })
                .await
                .expect("阻塞任务内部已捕获业务 panic");
                state = next;
                if !outcome {
                    failed.store(true, Ordering::Release);
                    state.failed();
                }
                let _ = reply.send(if outcome {
                    Ok(())
                } else {
                    Err(Error::State("内核写任务异常，提交结果未知".into()))
                });
            }
            Command::Read(generation, work, reply) => {
                let vault = if state.matches(generation) {
                    state.vault().cloned()
                } else {
                    Err(Error::State("笔记库已切换，请重试".into()))
                };
                let Ok(vault) = vault else {
                    let _ = reply.send(vault.map(|_| ()));
                    continue;
                };
                let permits = Arc::clone(&permits);
                reads.spawn(async move {
                    let _permit = permits.acquire_owned().await.expect("读取许可不会关闭");
                    let result = tokio::task::spawn_blocking(move || work(vault)).await;
                    let _ = reply.send(
                        result.map_err(|error| Error::State(format!("内核读任务异常：{error}"))),
                    );
                });
            }
            Command::Shutdown(reply) => {
                while reads.join_next().await.is_some() {}
                let result = tokio::task::spawn_blocking(move || state.close()).await;
                let publication_result = publication
                    .await
                    .map_err(|error| Error::State(format!("索引发布停机失败：{error}")));
                let _ = reply.send(
                    result
                        .map_err(|error| Error::State(format!("内核停机失败：{error}")))
                        .and_then(|r| r)
                        .and(publication_result),
                );
                return;
            }
        }
    }
    while reads.join_next().await.is_some() {}
    let _ = tokio::task::spawn_blocking(move || state.close()).await;
    let _ = publication.await;
}
