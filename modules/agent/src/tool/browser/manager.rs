use super::{BrowserConfig, BrowserInput, BrowserOutput, BrowserSnapshot, BrowserStatus};
use crate::{CancellationToken, ExecutionContext, tool::ToolError};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, watch};

/// actor 已接收的动作；调用方停止等待后仍由 actor 负责结算并保留回执。
pub(super) struct Request {
    /// 已校验并绑定会话的动作。
    pub action: BrowserInput,
    /// 用于禁止重复副作用的调用标识。
    pub id: String,
    /// 包含取消和截止时间；不代表可以撤销已派发动作。
    pub context: ExecutionContext,
    /// 单次交付通道；通道关闭不能丢弃运行时迟到的执行事实。
    pub reply: oneshot::Sender<Result<BrowserOutput, String>>,
}

struct Handle {
    config: Arc<BrowserConfig>,
    sender: mpsc::Sender<Request>,
    done: watch::Receiver<Option<Result<(), String>>>,
}

/// 同一锁决定关闭与首次启动，避免会话关闭期间漏登记浏览器进程。
#[derive(Default)]
struct State {
    closed: bool,
    handle: Option<Handle>,
}

/// 会话拥有浏览器 actor；actor 不持有会话强引用，运行取消不会丢弃未结算动作。
#[derive(Default)]
pub(crate) struct Manager {
    state: Mutex<State>,
    snapshot: Arc<Mutex<BrowserSnapshot>>,
    cancellation: CancellationToken,
}

impl Manager {
    /// 返回当前状态的独立副本，不消费回执或启动浏览器；锁被污染时无法继续满足会话契约。
    pub(crate) fn snapshot(&self) -> BrowserSnapshot {
        self.snapshot.lock().expect("浏览器状态锁被污染").clone()
    }

    /// 将已校验动作排队至本会话唯一 actor；返回真实结算，取消时 actor 仍继续收取迟到回执。
    /// config 必须始终指向同一冻结配置；changed 必须快速返回且不得持有强会话引用。
    /// 会话关闭、运行预算耗尽、配置被替换或运行时通道失败时返回 ToolError。
    pub(crate) async fn execute(
        &self,
        config: Arc<BrowserConfig>,
        changed: Arc<dyn Fn() + Send + Sync>,
        action: BrowserInput,
        id: String,
        context: ExecutionContext,
    ) -> Result<BrowserOutput, ToolError> {
        context
            .check()
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let sender = {
            let mut state = self.state.lock().expect("浏览器会话锁被污染");
            if state.closed {
                return Err(ToolError::Execution("浏览器会话已关闭".into()));
            }
            if state.handle.is_none() {
                if matches!(
                    action,
                    BrowserInput::Preview { .. } | BrowserInput::HumanInput { .. }
                ) {
                    return Err(ToolError::Execution("浏览器尚未启动".into()));
                }
                let (sender, receiver) = mpsc::channel(32);
                let (finished, done) = watch::channel(None);
                self.snapshot.lock().expect("浏览器状态锁被污染").status = BrowserStatus::Starting;
                tokio::spawn(super::worker::run(
                    config.clone(),
                    receiver,
                    self.cancellation.clone(),
                    self.snapshot.clone(),
                    changed.clone(),
                    finished,
                ));
                state.handle = Some(Handle {
                    config: config.clone(),
                    sender,
                    done,
                });
            }
            let handle = state.handle.as_ref().expect("浏览器已登记");
            if !Arc::ptr_eq(&handle.config, &config) {
                return Err(ToolError::Execution(
                    "同一会话不能切换浏览器运行配置".into(),
                ));
            }
            handle.sender.clone()
        };
        if !matches!(action, BrowserInput::Preview { .. }) {
            changed();
        }
        let (reply, received) = oneshot::channel();
        context
            .wait(sender.send(Request {
                action,
                id,
                context: context.clone(),
                reply,
            }))
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?
            .map_err(|_| {
                ToolError::Infrastructure(
                    self.snapshot()
                        .error
                        .unwrap_or_else(|| "浏览器运行时已结束".into()),
                )
            })?;
        context
            .wait(received)
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?
            .map_err(|_| {
                ToolError::Infrastructure(
                    self.snapshot()
                        .error
                        .unwrap_or_else(|| "浏览器回执通道中断".into()),
                )
            })?
            .map_err(ToolError::Infrastructure)
    }

    /// 禁止新动作并取消 actor，等待所有浏览器资源回收；可重复调用，清理失败时返回诊断。
    pub(crate) async fn close(&self) -> Result<(), String> {
        let done = {
            let mut state = self.state.lock().expect("浏览器会话锁被污染");
            state.closed = true;
            self.cancellation.cancel();
            state.handle.as_ref().map(|handle| handle.done.clone())
        };
        if let Some(mut done) = done {
            loop {
                if let Some(result) = done.borrow().clone() {
                    return result;
                }
                done.changed()
                    .await
                    .map_err(|_| "浏览器资源清理缺少完成通知")?;
            }
        }
        self.snapshot.lock().expect("浏览器状态锁被污染").status = BrowserStatus::Closed;
        Ok(())
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}
