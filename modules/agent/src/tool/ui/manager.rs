use super::{
    UiInput, UiOutput, UiTool,
    process::{ATTACHMENT_LIMIT, Process},
};
use crate::{
    CancellationToken,
    tool::{ToolContext, ToolError},
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot, watch};

/// 已登记脚本与执行预算；actor 持有到结算，等待者取消不撤销已发生的动作。
pub(super) struct Request {
    pub(super) tool: UiTool,
    pub(super) input: UiInput,
    pub(super) context: ToolContext,
    pub(super) reply: oneshot::Sender<Result<UiOutput, String>>,
}
/// actor 的发送端与结算通知同属会话，关闭等待者不拥有 actor 的生命周期。
struct Handle {
    sender: mpsc::Sender<Request>,
    done: watch::Receiver<Option<Result<(), String>>>,
}
#[derive(PartialEq)]
/// 首次执行冻结入口、工作区和 helper，后续轮次只能切换模型能力。
struct Configuration {
    executable: std::path::PathBuf,
    workspace: Option<std::path::PathBuf>,
    helper: Option<std::path::PathBuf>,
    broker: Option<std::path::PathBuf>,
}
#[derive(Default)]
/// 同一把锁决定绑定、启动与关闭；cleanup 缓存唯一关闭结果，避免重复清理冒充成功。
struct State {
    closed: bool,
    handle: Option<Handle>,
    configuration: Option<Configuration>,
    broker: Option<(super::broker::UiBroker, String)>,
    cleanup: Option<watch::Receiver<Option<Result<(), String>>>>,
}

/// 会话持有唯一脚本 actor；取消只终止当前脚本，不丢弃后台资源的迟到结算。
#[derive(Default)]
pub(crate) struct Manager {
    state: Mutex<State>,
    cancellation: CancellationToken,
    snapshot: Arc<Mutex<super::UiSnapshot>>,
    browser_epoch: Mutex<u64>,
}
impl Manager {
    pub(crate) fn snapshot(&self) -> super::UiSnapshot {
        let mut snapshot = self.snapshot.lock().expect("UI 快照锁被污染").clone();
        if let Some((broker, session)) = self.state.lock().expect("UI 会话锁被污染").broker.as_ref()
        {
            snapshot.connections = broker.connections(session);
            snapshot.receipts = broker.receipts(session);
        }
        snapshot
    }
    pub(crate) fn set_control(&self, control: super::computer::UiAccessRequest) {
        self.snapshot.lock().expect("UI 快照锁被污染").control = Some(control);
    }
    pub(crate) fn bind(
        &self,
        broker: super::broker::UiBroker,
        session: &str,
        label: &str,
    ) -> Result<(), ToolError> {
        let mut state = self.state.lock().expect("UI 会话锁被污染");
        if state.closed {
            return Err(ToolError::Execution("UI 会话已关闭".into()));
        }
        let registered = &mut state.broker;
        if let Some((existing, id)) = registered.as_ref() {
            if id != session || !existing.same(&broker) {
                return Err(ToolError::Execution(
                    "同一会话不能替换 UI 连接所有者".into(),
                ));
            }
        } else {
            broker.register(session, label);
            *registered = Some((broker, session.into()));
        }
        Ok(())
    }
    pub(crate) async fn execute(
        &self,
        tool: UiTool,
        input: UiInput,
        context: ToolContext,
    ) -> Result<UiOutput, ToolError> {
        context
            .execution
            .check()
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let sender = {
            let mut state = self.state.lock().expect("UI 会话锁被污染");
            if state.closed {
                return Err(ToolError::Execution("UI 会话已关闭".into()));
            }
            let configuration = Configuration {
                executable: (*tool.executable).clone(),
                workspace: tool
                    .connections
                    .as_ref()
                    .map(|config| config.workspace.clone()),
                helper: tool
                    .connections
                    .as_ref()
                    .and_then(|config| config.computer_helper.clone()),
                broker: tool
                    .connections
                    .as_ref()
                    .map(|config| config.broker.configuration_path()),
            };
            if state
                .configuration
                .as_ref()
                .is_some_and(|existing| existing != &configuration)
            {
                return Err(ToolError::Execution(
                    "同一会话不能替换 UI 执行入口、工作区或 helper".into(),
                ));
            }
            state.configuration = Some(configuration);
            if state.handle.is_none() {
                let (sender, receiver) = mpsc::channel(16);
                let (finished, done) = watch::channel(None);
                tokio::spawn(actor(
                    receiver,
                    self.cancellation.clone(),
                    finished,
                    self.snapshot.clone(),
                ));
                state.handle = Some(Handle { sender, done });
            }
            state
                .handle
                .as_ref()
                .expect("UI actor 已登记")
                .sender
                .clone()
        };
        let (reply, result) = oneshot::channel();
        context
            .execution
            .wait(sender.send(Request {
                tool,
                input,
                context: context.clone(),
                reply,
            }))
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?
            .map_err(|_| ToolError::Infrastructure("UI actor 已结束".into()))?;
        // actor 在截止或取消时终止 guest 并结算阶段；保留短暂清理预算，不能先丢弃重置回执。
        tokio::time::timeout_at(
            context.execution.deadline + std::time::Duration::from_secs(3),
            result,
        )
        .await
        .map_err(|_| ToolError::Infrastructure("UI 执行进程未在清理预算内结算".into()))?
        .map_err(|_| ToolError::Infrastructure("UI actor 缺少结束回执".into()))?
        .map_err(ToolError::Infrastructure)
    }
    /// 清理任务由会话拥有；取消某个等待者不会丢失释放确认，后续 close 复用同一结算。
    pub(crate) async fn close(&self) -> Result<(), String> {
        let done = {
            let mut state = self.state.lock().expect("UI 会话锁被污染");
            if let Some(done) = &state.cleanup {
                done.clone()
            } else {
                state.closed = true;
                self.cancellation.cancel();
                let actor = state.handle.as_ref().map(|handle| handle.done.clone());
                let broker = state.broker.take();
                let snapshot = self.snapshot.clone();
                snapshot.lock().expect("UI 快照锁被污染").status = super::UiStatus::Closed;
                let (finished, done) = watch::channel(None);
                tokio::spawn(async move {
                    let process = async {
                        if let Some(done) = actor {
                            wait_done(done).await
                        } else {
                            Ok(())
                        }
                    };
                    let release = async {
                        if let Some((broker, session)) = broker {
                            broker.release_confirmed(&session).await
                        } else {
                            Ok(())
                        }
                    };
                    let (process, release) = tokio::join!(process, release);
                    let errors: Vec<_> = [process, release]
                        .into_iter()
                        .filter_map(Result::err)
                        .collect();
                    let result = if errors.is_empty() {
                        Ok(())
                    } else {
                        Err(errors.join("；"))
                    };
                    if let Err(error) = &result {
                        snapshot.lock().expect("UI 快照锁被污染").error = Some(error.clone());
                    }
                    finished.send_replace(Some(result));
                });
                state.cleanup = Some(done.clone());
                done
            }
        };
        wait_done(done).await
    }
    pub(crate) fn needs_browser_invalidation(&self, broker: &super::broker::UiBroker) -> bool {
        let mut epoch = self.browser_epoch.lock().expect("UI 关联代次锁被污染");
        let current = broker.browser_epoch();
        if *epoch == current {
            false
        } else {
            *epoch = current;
            true
        }
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Ok(state) = self.state.get_mut()
            && let Some((broker, session)) = &state.broker
        {
            broker.release(session);
        }
    }
}

async fn wait_done(mut done: watch::Receiver<Option<Result<(), String>>>) -> Result<(), String> {
    loop {
        if let Some(result) = done.borrow().clone() {
            return result;
        }
        done.changed().await.map_err(|_| "UI 清理缺少结束通知")?;
    }
}

async fn actor(
    mut receiver: mpsc::Receiver<Request>,
    cancellation: CancellationToken,
    finished: watch::Sender<Option<Result<(), String>>>,
    snapshot: Arc<Mutex<super::UiSnapshot>>,
) {
    let mut process: Option<Process> = None;
    let mut seen = BTreeSet::new();
    let mut cache: BTreeMap<String, (UiInput, UiOutput)> = BTreeMap::new();
    let mut order = VecDeque::new();
    let cleanup = loop {
        let request = tokio::select! {biased;()=cancellation.cancelled()=>break Ok(()),request=receiver.recv()=>match request {Some(request)=>request,None=>break Ok(())}};
        let id = request.context.call_id.clone();
        if let Some((input, result)) = cache.get(&id) {
            let reply = if input == &request.input {
                Ok(result.clone())
            } else {
                Err("同一脚本调用标识不能用于不同代码，禁止重放".into())
            };
            let _ = request.reply.send(reply);
            continue;
        }
        if seen.contains(&id) || seen.len() >= 4096 {
            let _ = request.reply.send(Err(
                "脚本已经结算或会话调用标识数量超限，禁止重复执行".into()
            ));
            continue;
        }
        if let Err(error) = request.context.execution.check() {
            let _ = request.reply.send(Err(error.to_string()));
            continue;
        }
        seen.insert(id.clone());
        {
            let mut snapshot = snapshot.lock().expect("UI 快照锁被污染");
            snapshot.status = super::UiStatus::Busy;
            snapshot.call = Some(id.clone());
            snapshot.error = None;
        }
        (request.tool.changed)();
        if process.is_none() {
            match Process::start(&request.tool) {
                Ok(child) => process = Some(child),
                Err(error) => {
                    {
                        let mut snapshot = snapshot.lock().expect("UI 快照锁被污染");
                        snapshot.status = super::UiStatus::Failed;
                        snapshot.call = None;
                        snapshot.error = Some(error.clone());
                    }
                    (request.tool.changed)();
                    let _ = request.reply.send(Err(error));
                    continue;
                }
            }
        }
        let result = tokio::select! {biased;()=cancellation.cancelled()=>{request.context.execution.cancellation.cancel();Err("UI 会话已关闭".into())},result=process.as_mut().expect("JS 进程已启动").run(&request)=>result};
        if (result.is_err()
            || result
                .as_ref()
                .is_ok_and(|output| output.reset && output.error.is_some()))
            && let Some(mut child) = process.take()
        {
            let _ = child.stop().await;
        }
        if let Ok(output) = &result {
            cache.insert(id.clone(), (request.input.clone(), output.clone()));
            order.push_back(id);
            while order.len() > 8
                || cache
                    .values()
                    .flat_map(|(_, output)| &output.images)
                    .map(|image| image.data().len())
                    .sum::<usize>()
                    > ATTACHMENT_LIMIT
            {
                if let Some(id) = order.pop_front() {
                    cache.remove(&id);
                }
            }
        }
        {
            let mut snapshot = snapshot.lock().expect("UI 快照锁被污染");
            snapshot.call = None;
            if !matches!(snapshot.status, super::UiStatus::Closed) {
                snapshot.status = if result.is_err() {
                    super::UiStatus::Failed
                } else {
                    super::UiStatus::Ready
                };
            }
            snapshot.error = match &result {
                Ok(output) => output.error.clone(),
                Err(error) => Some(error.clone()),
            };
            if result.as_ref().map_or(true, |output| output.reset) {
                snapshot.generation += 1;
            }
        }
        (request.tool.changed)();
        let _ = request.reply.send(result);
    };
    let result = if let Some(mut child) = process {
        child.stop().await.and(cleanup)
    } else {
        cleanup
    };
    {
        let mut snapshot = snapshot.lock().expect("UI 快照锁被污染");
        snapshot.status = super::UiStatus::Closed;
        snapshot.call = None;
    }
    finished.send_replace(Some(result));
}
