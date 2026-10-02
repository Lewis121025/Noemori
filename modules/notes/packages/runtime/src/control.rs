//! 取消与进度只接触内存，不等待磁盘或命令队列。

use serde::Serialize;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};

/// 一致的单阶段进度快照；未知总数以 null 返回。
#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    /// 当前阶段的稳定协议名称。
    pub phase: String,
    /// 已完成的条目数。
    pub completed: usize,
    /// 当前阶段总量，未知时为空。
    pub total: Option<usize>,
}

/// 控制句柄可跨线程复制；0 可取消，1 已取消，2 已进入不可中断提交。
#[derive(Clone)]
pub struct OperationControl {
    status: Arc<AtomicU8>,
    progress: Arc<Mutex<Progress>>,
}

impl Default for OperationControl {
    fn default() -> Self {
        Self {
            status: Arc::new(AtomicU8::new(0)),
            progress: Arc::new(Mutex::new(Progress {
                phase: "checking".into(),
                completed: 0,
                total: Some(0),
            })),
        }
    }
}

impl OperationControl {
    pub(crate) fn in_use(&self) -> bool {
        Arc::strong_count(&self.status) > 1
    }
    /// 请求取消；返回 false 表示已经取消或进入提交，不会撤销已完成的事务。
    #[must_use]
    pub fn cancel(&self) -> bool {
        self.status
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// 查询取消标记，不访问文件系统。
    #[must_use]
    pub fn cancelled(&self) -> bool {
        self.status.load(Ordering::Acquire) == 1
    }

    /// 原子进入提交阶段；取消先到时返回 false。
    pub(crate) fn commit(&self) -> bool {
        let accepted = self
            .status
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        if accepted {
            self.update("committing", 0, None);
        }
        accepted
    }

    /// 复制完整快照；进度锁只保护固定大小计数与阶段文本。
    pub fn progress(&self) -> Progress {
        self.progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// 发布单阶段计数；调用方不能把排队计入完成量。
    pub(crate) fn update(&self, phase: &str, completed: usize, total: Option<usize>) {
        *self
            .progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Progress {
            phase: phase.into(),
            completed,
            total,
        };
    }
}

#[cfg(test)]
#[path = "../../../../../test/notes/runtime/unit/control.rs"]
mod tests;
