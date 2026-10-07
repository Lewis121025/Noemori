use super::{TerminalEvent, TerminalInfo, TerminalStatus, process::State};
use std::sync::{Arc, Weak};
use tokio::sync::watch;

/// 宿主的独立实时输出订阅；慢读者从日志续读，不需要无界消息队列，也不会阻塞子进程。
///
/// 订阅存在期间阻止自动容量回收；显式 release 或关闭会话仍可释放日志并结束订阅。
pub struct TerminalSubscription {
    state: Weak<State>,
    updates: watch::Receiver<Option<TerminalInfo>>,
    offset: u64,
    finished: bool,
}

impl TerminalSubscription {
    pub(super) fn new(state: &Arc<State>, offset: u64) -> Self {
        Self {
            state: Arc::downgrade(state),
            updates: state.subscribe(),
            offset,
            finished: false,
        }
    }

    /// 返回下一次原始字节读取位置；可用于断线后重新订阅，取消 recv 不会推进此位置。
    pub fn next_offset(&self) -> u64 {
        self.offset
    }

    /// 返回已提交的进程终态；与输出日志的生命周期独立，记录释放后仍可用于宿主投影。
    /// 尚未完成的进程返回 None，不会把日志读取失败推断为进程已经退出。
    pub fn final_info(&self) -> Option<TerminalInfo> {
        self.updates.borrow().clone()
    }

    /// 为同一授权记录创建独立读者；不会推进当前游标，显式释放或关闭会话仍然有效。
    /// # 错误
    /// 记录已经释放或会话关闭时返回错误；偏移超出日志在首次读取时报告。
    pub fn fork(&self, offset: u64) -> Result<Self, String> {
        let state = self.state.upgrade().ok_or("终端记录已释放或会话已关闭")?;
        Ok(Self::new(&state, offset))
    }

    /// 等待下一段输出或唯一退出事件；完成后返回 None，可随时取消等待。
    ///
    /// # 错误
    /// 游标超过现有日志、日志 I/O 失败或资源被显式释放时返回原因并结束订阅。
    pub async fn recv(&mut self) -> Result<Option<TerminalEvent>, String> {
        if self.finished {
            return Ok(None);
        }
        let result = self.next().await;
        if result.is_err() {
            self.finish();
        }
        result
    }

    async fn next(&mut self) -> Result<Option<TerminalEvent>, String> {
        loop {
            // 先确认通知版本再读取快照，写入发生在读取与等待之间也不会漏唤醒。
            self.updates.borrow_and_update();
            let state = self.state.upgrade().ok_or("终端记录已释放或会话已关闭")?;
            let page = state.read_bytes(self.offset, 8192).await?;
            drop(state);
            if let Some(chunk) = page.chunks.into_iter().next() {
                self.offset = chunk.next_offset;
                return Ok(Some(TerminalEvent::Output {
                    session_id: page.process.session_id,
                    chunk,
                }));
            }
            if page.process.status != TerminalStatus::Running {
                self.finish();
                return Ok(Some(TerminalEvent::Exited {
                    process: page.process,
                }));
            }
            // 等待期间只持弱引用，订阅不能延长会话关闭后的资源生命周期。
            self.updates
                .changed()
                .await
                .map_err(|_| "终端记录已释放或会话已关闭")?;
        }
    }

    fn finish(&mut self) {
        if !self.finished {
            if let Some(state) = self.state.upgrade() {
                state.unsubscribe();
            }
            self.finished = true;
        }
    }
}

impl Drop for TerminalSubscription {
    fn drop(&mut self) {
        self.finish();
    }
}
