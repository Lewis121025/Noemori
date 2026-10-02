//! 批次预检、已提交前缀及会话迁移属于同一运行时事务边界。

use crate::{Error, OperationControl, Result, State};
use noemori_vault::{EntryKind, EntryMutation, RenameOutcome};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
enum Action {
    Move { destination: String },
    Trash,
}

#[derive(Deserialize)]
struct Request {
    root: String,
    paths: Vec<String>,
    #[serde(flatten)]
    action: Action,
}

fn independent(paths: &[String]) -> Vec<String> {
    let selected: HashSet<_> = paths.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    paths
        .iter()
        .filter(|path| {
            seen.insert(path.as_str())
                && !path
                    .match_indices('/')
                    .any(|(i, _)| selected.contains(&path[..i]))
        })
        .cloned()
        .collect()
}

fn system_trash(absolute: &Path) -> std::result::Result<(), noemori_vault::Error> {
    trash::delete(absolute)
        .map_err(|error| noemori_vault::Error::Io(std::io::Error::other(error.to_string())))
}

impl State {
    /// 创建条目并通知目录变化；参数和磁盘错误由 Vault 检查。
    /// # Errors
    /// 未开库、目标冲突或提交失败。
    pub fn create_entry(&self, path: &str, kind: EntryKind, bytes: &[u8]) -> Result<RenameOutcome> {
        let result = self.vault()?.create_entry(path, kind, bytes)?;
        self.changed(Vec::new(), false);
        Ok(result)
    }

    /// 重命名后统一迁移各分栏与目录状态；会话失败只附加警告。
    /// # Errors
    /// 文件事务提交前的错误。
    pub fn rename(&self, from: &str, to: &str) -> Result<RenameOutcome> {
        let result = self.vault()?.rename(from, to)?;
        let warning = self.remember_change(result.warning, from, Some(to));
        self.changed(Vec::new(), false);
        Ok(RenameOutcome { warning })
    }

    /// 移入系统废纸篓；不允许退化成永久删除。
    /// # Errors
    /// 文件或系统废纸篓操作失败。
    pub fn trash(&self, path: &str) -> Result<RenameOutcome> {
        let result = self.vault()?.trash_entry(path, system_trash)?;
        let warning = self.remember_change(result.warning, path, None);
        self.changed(Vec::new(), false);
        Ok(RenameOutcome { warning })
    }

    /// 按归属导入附件并发布实际路径；错误保持提交前失败或提交后警告的区别。
    /// # Errors
    /// 库已切换、非法附件或磁盘提交失败。
    pub fn import_attachment(
        &self,
        root: &str,
        from: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<noemori_vault::ImportedAttachment> {
        self.require_root(root)?;
        let result = self.vault()?.import_attachment(from, name, bytes)?;
        self.changed(vec![result.path.clone()], result.warning.is_none());
        Ok(result)
    }

    /// 整批预检，逐项提交并报告真实前缀；主动停止不回滚已完成项。
    /// # Errors
    /// 请求非法、库归属错误或初始目录不可读；执行后错误放入 issues。
    pub fn entry_batch(&self, value: Value, control: &OperationControl) -> Result<Value> {
        self.entry_batch_with_trash(value, control, system_trash)
    }

    // 仅注入平台废纸篓调用，预检、文件事务、会话迁移及部分结果始终走同一条业务路径。
    fn entry_batch_with_trash(
        &self,
        value: Value,
        control: &OperationControl,
        mut move_to_trash: impl FnMut(&Path) -> std::result::Result<(), noemori_vault::Error>,
    ) -> Result<Value> {
        let request: Request = serde_json::from_value(value)
            .map_err(|e| Error::State(format!("批量操作请求无效：{e}")))?;
        self.require_root(&request.root)?;
        if request.paths.is_empty()
            || request.paths.len() > 10_000
            || !request.paths.iter().all(|p| crate::session::entry_path(p))
        {
            return Err(Error::State("批量操作包含无效路径".into()));
        }
        if let Action::Move { destination } = &request.action {
            if !destination.is_empty() && !crate::session::entry_path(destination) {
                return Err(Error::State("批量操作目标无效".into()));
            }
        }
        let vault = self.vault()?;
        let BatchPlan {
            paths,
            changes,
            skipped,
            mut issues,
        } = plan(vault, &request)?;
        let mut completed = 0;
        let mut warnings = Vec::new();
        control.update("checking", 0, Some(changes.len()));
        if issues.is_empty() && !changes.is_empty() && !control.cancelled() {
            let mut confirm = |count: usize| -> std::result::Result<bool, noemori_vault::Error> {
                for change in &changes[completed..count] {
                    if let Some(warning) =
                        self.remember_change(None, &change.from, change.to.as_deref())
                    {
                        warnings.push(format!("{}：{warning}", change.from));
                    }
                }
                completed = count;
                control.update("running", count, Some(changes.len()));
                Ok(!control.cancelled())
            };
            match &request.action {
                Action::Move { .. } => match vault.rename_batch(&changes, &mut confirm) {
                    Ok(outcome) => {
                        confirm(outcome.completed)?;
                        if let Some(issue) = outcome.issue {
                            issues.push(json!({"path": issue.path, "message": issue.message}));
                        }
                        if let Some(warning) = outcome.warning {
                            warnings.push(warning);
                        }
                    }
                    Err(error) => issues.push(json!({"path": "", "message": error.to_string()})),
                },
                Action::Trash => {
                    if let Err(error) = vault.check_entry_batch(&changes) {
                        issues.push(json!({"path": "", "message": error.to_string()}));
                    } else {
                        let mut item_warnings = Vec::new();
                        if confirm(0)? {
                            for (index, change) in changes.iter().enumerate() {
                                match vault.trash_entry(&change.from, &mut move_to_trash) {
                                    Ok(outcome) => {
                                        if let Some(warning) = outcome.warning {
                                            item_warnings
                                                .push(format!("{}：{warning}", change.from));
                                        }
                                    }
                                    Err(error) => {
                                        issues.push(json!({"path": change.from, "message": error.to_string()}));
                                        break;
                                    }
                                }
                                if !confirm(index + 1)? {
                                    break;
                                }
                            }
                        }
                        warnings.extend(item_warnings);
                    }
                }
            }
        }
        let committed: Vec<_> = changes[..completed]
            .iter()
            .map(|c| json!({"from": c.from, "to": c.to}))
            .collect();
        let done: HashSet<_> = changes[..completed]
            .iter()
            .map(|c| &c.from)
            .chain(skipped.iter())
            .collect();
        let remaining: Vec<_> = paths.iter().filter(|p| !done.contains(p)).collect();
        let warning = (!warnings.is_empty()).then(|| warnings.join("；"));
        if completed > 0 {
            self.changed(Vec::new(), warning.is_none());
        }
        Ok(
            json!({"completed": committed, "remaining": remaining, "skipped": skipped, "issues": issues, "warning": warning}),
        )
    }
}

#[cfg(test)]
#[path = "../../../../../test/notes/runtime/integration/batch.rs"]
mod tests;

/// 同一清单上的整批预检；任何冲突都在第一项文件事务之前发现。
struct BatchPlan {
    paths: Vec<String>,
    changes: Vec<EntryMutation>,
    skipped: Vec<String>,
    issues: Vec<Value>,
}

fn plan(vault: &noemori_vault::Vault, request: &Request) -> Result<BatchPlan> {
    let paths = independent(&request.paths);
    let entries = vault.list_entries()?;
    let inventory: HashMap<_, _> = entries.iter().map(|e| (e.path.as_str(), e)).collect();
    let mut occupied: HashSet<String> = inventory.keys().map(|p| (*p).into()).collect();
    for entry in &entries {
        for (i, _) in entry.path.match_indices('/') {
            occupied.insert(entry.path[..i].into());
        }
    }
    let mut changes = Vec::new();
    let mut skipped = Vec::new();
    let mut issues = Vec::new();
    let mut destinations = HashSet::new();
    if let Action::Move { destination } = &request.action {
        if !destination.is_empty()
            && !inventory
                .get(destination.as_str())
                .is_some_and(|e| e.kind == EntryKind::Directory && !e.recovery_only)
        {
            issues.push(json!({"path": destination, "message": "目标文件夹不存在或不可用"}));
        }
    }
    for path in &paths {
        if inventory.get(path.as_str()).is_none_or(|e| e.recovery_only) {
            issues.push(json!({"path": path, "message": "条目已不存在，或需要先处理恢复草稿"}));
            continue;
        }
        let to = match &request.action {
            Action::Trash => None,
            Action::Move { destination } => {
                let name = path.rsplit('/').next().unwrap_or(path);
                let to = if destination.is_empty() {
                    name.into()
                } else {
                    format!("{destination}/{name}")
                };
                if &to == path {
                    skipped.push(path.clone());
                    continue;
                }
                if destination == path || destination.starts_with(&format!("{path}/")) {
                    issues.push(json!({"path": path, "message": "不能移动到自身或子文件夹"}));
                } else if occupied.contains(&to) || destinations.contains(&to) {
                    issues
                        .push(json!({"path": path, "message": format!("目标已有同名条目：{to}")}));
                }
                destinations.insert(to.clone());
                Some(to)
            }
        };
        changes.push(EntryMutation {
            from: path.clone(),
            to,
        });
    }
    Ok(BatchPlan {
        paths,
        changes,
        skipped,
        issues,
    })
}
