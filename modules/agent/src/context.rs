//! 模型与工具共享运行取消和截止时间，避免只取消最外层等待。

use std::{future::Future, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::Error;

/// 单次执行的取消和时间边界；克隆共享取消状态。
#[derive(Clone, Debug)]
pub struct ExecutionContext {
    /// 调用方和运行内步骤共享的取消信号。
    pub cancellation: CancellationToken,
    /// 使用单调时钟的截止时间。
    pub deadline: Instant,
}

impl ExecutionContext {
    /// 用给定取消信号和超时创建执行上下文。
    ///
    /// # 错误
    /// 超时为零或超出时钟表示范围时返回配置错误。
    pub fn new(cancellation: CancellationToken, timeout: Duration) -> Result<Self, Error> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .filter(|_| !timeout.is_zero())
            .ok_or_else(|| Error::Config("超时必须为可表示的正时长".into()))?;
        Ok(Self {
            cancellation,
            deadline,
        })
    }

    /// 在执行外部操作前检查状态；取消优先于同时发生的超时。
    ///
    /// # 错误
    /// 已取消或到达截止时间时返回对应终止原因。
    pub fn check(&self) -> Result<(), Error> {
        if self.cancellation.is_cancelled() {
            Err(Error::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(Error::Timeout)
        } else {
            Ok(())
        }
    }

    /// 等待一个操作，同时响应取消和截止时间；终止时释放该操作的 future。
    ///
    /// 返回 `operation` 的原始输出；它自身的失败不会被误归类为取消或超时。
    ///
    /// # 错误
    /// 返回取消或超时；操作本身的结果保持原类型。
    pub async fn wait<F: Future>(&self, operation: F) -> Result<F::Output, Error> {
        self.check()?;
        tokio::select! {
            biased;
            () = self.cancellation.cancelled() => Err(Error::Cancelled),
            () = tokio::time::sleep_until(self.deadline) => Err(Error::Timeout),
            result = operation => Ok(result),
        }
    }
}
