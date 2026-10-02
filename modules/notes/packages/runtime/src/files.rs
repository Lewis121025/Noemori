//! 只有真实的正文或链接变更触发排名发布，会话、草稿与书签不消耗索引发布通道。

use crate::{Result, State};
use noemori_vault::{RenameOutcome, SavedCopy, WriteOutcome};

impl State {
    /// 按基线完成文件事务；仅成功提交需要准备新的全文版本。
    /// # Errors
    /// 未开库、恢复草稿持久化或正文提交失败。
    pub fn write_file(
        &self,
        path: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<WriteOutcome> {
        let outcome = self.vault()?.write(path, bytes, expected)?;
        if matches!(outcome, WriteOutcome::Saved { .. }) {
            self.schedule_publication();
        }
        Ok(outcome)
    }

    /// 独占保存新副本并准备排名；返回实际路径，不能重新猜测文件名。
    /// # Errors
    /// 路径、恢复记录或文件提交失败。
    pub fn write_copy(
        &self,
        path: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<SavedCopy> {
        let outcome = self.vault()?.write_copy(path, bytes, expected)?;
        self.schedule_publication();
        Ok(outcome)
    }

    /// 按原始字节区间建立显式链接；保留原文校验与提交后警告。
    /// # Errors
    /// 未开库、范围失效或文件事务失败。
    pub fn linkify_mention(
        &self,
        from: &str,
        start: i64,
        end: i64,
        expected: &str,
        target: &str,
    ) -> Result<RenameOutcome> {
        let outcome = self
            .vault()?
            .linkify_mention(from, start, end, expected, target)?;
        self.schedule_publication();
        Ok(outcome)
    }
}
