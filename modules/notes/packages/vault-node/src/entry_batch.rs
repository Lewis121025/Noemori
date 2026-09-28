//! 批次回调只报告提交边界；回调期间禁止重入持锁的原生状态。

use std::cell::Cell;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::entries::JsEntryMutation;
use crate::runtime::with_vault;

thread_local! {
    static IN_PROGRESS_CALLBACK: Cell<bool> = const { Cell::new(false) };
}

struct ProgressCallback;

impl ProgressCallback {
    fn enter() -> Self {
        IN_PROGRESS_CALLBACK.set(true);
        Self
    }
}

impl Drop for ProgressCallback {
    fn drop(&mut self) {
        IN_PROGRESS_CALLBACK.set(false);
    }
}

/// 状态锁入口在获取互斥锁前拒绝同步回调重入，避免同一线程永远等待自身。
pub(crate) fn check_callback_reentry() -> Result<()> {
    if IN_PROGRESS_CALLBACK.get() {
        return Err(Error::from_reason("批次进度回调不能重新调用内核接口"));
    }
    Ok(())
}

/// 首个失败的源路径与原因；空路径表示进度回调失败。
#[napi(object)]
pub struct JsRenameBatchIssue {
    /// 规范的库内源路径，或表示批次错误的空字符串。
    pub path: String,
    /// 可直接展示的失败原因。
    pub message: String,
}

/// 已提交前缀是重试的唯一边界，索引警告不会让已完成文件再次执行。
#[napi(object)]
pub struct JsRenameBatchOutcome {
    /// 已独立持久化的条目数。
    pub completed: u32,
    /// 首个执行或回调失败，主动停止时缺省。
    pub issue: Option<JsRenameBatchIssue>,
    /// 提交后的清理、书签或索引警告。
    pub warning: Option<String>,
}

/// 整批预检后复用快照逐项移动；同步回调收到完成数，返回 false 在事务之间停止。
/// 回调只能保存外部会话或读取停止信号，不能重入内核；异常进入结果并收尾索引。
/// # Errors
/// 未打开库、预检或快照失败时抛错且本批尚未提交；执行后的错误保留真实完成数。
#[napi]
pub fn entry_rename_batch(
    changes: Vec<JsEntryMutation>,
    #[napi(ts_arg_type = "(completed: number) => boolean")] progress: Function<'_, u32, bool>,
) -> Result<JsRenameBatchOutcome> {
    let changes: Vec<_> = changes
        .into_iter()
        .map(|change| nous_vault::EntryMutation {
            from: change.from,
            to: change.to,
        })
        .collect();
    let outcome = with_vault(|vault| {
        vault.rename_batch(&changes, |completed| {
            let _guard = ProgressCallback::enter();
            // 输入来自 Node-API 的 u32 长度数组，完成数不会超过该范围。
            progress
                .call(completed as u32)
                .map_err(|error| nous_vault::Error::Io(std::io::Error::other(error.to_string())))
        })
    })?;
    Ok(JsRenameBatchOutcome {
        completed: outcome.completed as u32,
        issue: outcome.issue.map(|issue| JsRenameBatchIssue {
            path: issue.path,
            message: issue.message,
        }),
        warning: outcome.warning,
    })
}
