//! 一次移动批次持有写锁和实时快照，逐项提交并通知，任何正常退出都统一收尾索引。

use super::{append_warning, recover_pending};
use crate::{EntryMutation, Error, Vault};

/// 当前项或批次观察者失败；已完成项必须继续由结果的完成数确认。
#[derive(Debug)]
pub struct RenameBatchIssue {
    /// 失败项的源路径；空字符串表示观察者失败。
    pub path: String,
    /// 可显示的原因，不把提交后的派生警告混为文件失败。
    pub message: String,
}

/// 批次的真实提交边界，停止和失败均不回滚先前成功项。
#[derive(Debug, Default)]
pub struct RenameBatchOutcome {
    /// 输入前缀中已独立持久化的条目数，其余项可用新快照重试。
    pub completed: usize,
    /// 首个执行或观察者错误；主动停止时为 `None`。
    pub issue: Option<RenameBatchIssue>,
    /// 提交后的清理、书签和最终索引警告。
    pub warning: Option<String>,
}

impl Vault {
    /// 整批预检移动请求，复用内容快照并按输入顺序独立提交，结束时刷新一次索引。
    ///
    /// `changes` 仅接受具有目标的独立移动项。`progress` 在预检后以 0 调用，
    /// 此后每项提交后传入真实完成数；返回 false 在事务之间停止，错误也保留完成数。
    /// 回调处于批次写锁内，只能观察或持久化外部会话，禁止重新调用库写入或刷新接口。
    /// # Errors
    /// 锁、恢复、预检或初始快照失败时返回错误且没有本批提交；执行后的错误进入结果。
    pub fn rename_batch(
        &self,
        changes: &[EntryMutation],
        mut progress: impl FnMut(usize) -> Result<bool, Error>,
    ) -> Result<RenameBatchOutcome, Error> {
        let _guard = self.lock_writes()?;
        recover_pending(self.root(), &self.recovery)?;
        let moves = changes
            .iter()
            .map(|change| {
                change
                    .to
                    .as_deref()
                    .map(|to| (change.from.as_str(), to))
                    .ok_or_else(|| Error::Io(std::io::Error::other("移动批次缺少目标路径")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.check_entry_batch_locked(changes)?;
        let mut result = RenameBatchOutcome::default();
        if moves.is_empty() {
            return Ok(result);
        }
        self.check_rename_drafts()?;
        let mut snapshot = self.read_rename_snapshot()?;
        if !result.notify(&mut progress) {
            return Ok(result);
        }
        for (from, to) in moves {
            match self.rename_from_snapshot(from, to, &mut snapshot) {
                Ok(outcome) => {
                    result.completed += 1;
                    if let Some(warning) = outcome.warning {
                        append_warning(&mut result.warning, format!("{from}：{warning}"));
                    }
                    if !result.notify(&mut progress) {
                        break;
                    }
                }
                Err(error) => {
                    result.issue = Some(RenameBatchIssue {
                        path: from.to_string(),
                        message: error.to_string(),
                    });
                    break;
                }
            }
        }
        // 内容复核也覆盖失败时观察到的外部编辑，不能因其保留时间戳而留下旧索引。
        if let Err(error) = self.refresh_index_after_batch() {
            append_warning(&mut result.warning, format!("链接索引更新失败：{error}"));
        }
        Ok(result)
    }
}

impl RenameBatchOutcome {
    fn notify(&mut self, progress: &mut impl FnMut(usize) -> Result<bool, Error>) -> bool {
        match progress(self.completed) {
            Ok(proceed) => proceed,
            Err(error) => {
                self.issue = Some(RenameBatchIssue {
                    path: String::new(),
                    message: error.to_string(),
                });
                false
            }
        }
    }
}
