//! 根据实时内容生成改名计划，并以持久化日志恢复中断的文件提交。

mod batch;
mod commit;
mod snapshot;

pub use batch::{RenameBatchIssue, RenameBatchOutcome};
mod source;

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::Path;

use crate::pathutil::{path_to_slashes, resolve_in_root};
use crate::recovery::RecoveryStore;
use crate::rename_journal::{FileChange, RenameJournal};
use crate::save::{read_optional, sync_parent};
use crate::vault::{resolve_against, Inventory};
use crate::{EntryMutation, Error, LinkKind, LinkRecord, Vault};
use commit::{apply_rename, replace_version};
use snapshot::{RenameDocument, RenameSnapshot};
use source::MoveSource;

/// 文件已完成改名；派生索引和日志清理的失败不撤销已提交内容。
#[derive(Debug)]
pub struct RenameOutcome {
    /// 提交后的警告；没有待处理问题时为 `None`。
    pub warning: Option<String>,
}

impl Vault {
    /// 在同一写锁内预检全部独立条目，不移动或删除用户文件。
    ///
    /// 移动检查完整源目录（含隐藏内容）、已有目标和未保存草稿；废纸篓仅检查相关草稿。
    /// 执行阶段仍须使用 `rename` / `trash_entry` 的事务校验，预检不是外部文件系统的锁。
    /// # Errors
    /// 无效或重叠请求、路径冲突、符号链接、源丢失、父目录丢失或草稿冲突时失败。
    pub fn check_entry_batch(&self, changes: &[EntryMutation]) -> Result<(), Error> {
        let _guard = self.lock_writes()?;
        recover_pending(self.root(), &self.recovery)?;
        self.check_entry_batch_locked(changes)
    }

    fn check_entry_batch_locked(&self, changes: &[EntryMutation]) -> Result<(), Error> {
        let mut sources = BTreeSet::new();
        let mut targets = BTreeSet::new();
        for change in changes {
            let from = relative_path(self.root(), &change.from)?;
            if from != change.from || !sources.insert(from) {
                return Err(Error::Io(io::Error::other(
                    "批量操作包含重复或非规范源路径",
                )));
            }
            if let Some(to) = &change.to {
                crate::entries::validate_entry_path(to)?;
                if !targets.insert(to) {
                    return Err(Error::Io(io::Error::other(format!("目标名称重复：{to}"))));
                }
            }
        }
        for path in &sources {
            if contains_source_ancestor(Path::new(path).parent(), &sources)? {
                return Err(Error::Io(io::Error::other("父文件夹与子条目不能重复执行")));
            }
        }
        if changes.iter().any(|change| change.to.is_some()) {
            self.check_entry_drafts(None)?;
        }
        for change in changes {
            let source = self.entry_path(&change.from)?;
            if let Some(to) = &change.to {
                let target = resolve_in_root(self.root(), to)?;
                if contains_source_ancestor(Some(Path::new(to)), &sources)? {
                    return Err(Error::Io(io::Error::other("不能移动到自身的子文件夹")));
                }
                if fs::symlink_metadata(&target).is_ok() {
                    return Err(Error::AlreadyExists { path: target });
                }
                if !target.parent().is_some_and(Path::is_dir) {
                    return Err(Error::Io(io::Error::other("目标父文件夹不存在")));
                }
                MoveSource::scan(self.root(), &change.from)?;
            } else {
                self.check_entry_drafts(Some(&source))?;
            }
        }
        Ok(())
    }

    /// 将 `from` 改名为 `to`，按当前源内容更新内部链接。
    ///
    /// 两个参数均为库内相对路径。提交前保存每个文件的前后版本；失败时回滚，
    /// 回滚遇到外部修改则保留日志与外部内容，后续写入和重新打开库会重试恢复。
    ///
    /// # Errors
    ///
    /// 路径非法、目标已存在、有未处理草稿、版本冲突或提交/恢复失败。
    pub fn rename(&self, from: &str, to: &str) -> Result<RenameOutcome, Error> {
        let _guard = self.lock_writes()?;
        recover_pending(self.root(), &self.recovery)?;
        crate::entries::validate_entry_path(to)?;
        let from = relative_path(self.root(), from)?;
        let to = relative_path(self.root(), to)?;
        if from == to {
            return Ok(RenameOutcome { warning: None });
        }
        self.check_rename_drafts()?;
        let mut snapshot = self.read_rename_snapshot()?;
        let mut outcome = self.rename_from_snapshot(&from, &to, &mut snapshot)?;
        if let Err(err) = self.refresh_index_locked() {
            append_warning(&mut outcome.warning, format!("链接索引更新失败：{err}"));
        }
        Ok(outcome)
    }

    /// 已持有写锁；批次与单项共用同一日志提交路径，快照只吸收已提交的变化。
    fn rename_from_snapshot(
        &self,
        from: &str,
        to: &str,
        snapshot: &mut RenameSnapshot,
    ) -> Result<RenameOutcome, Error> {
        recover_pending(self.root(), &self.recovery)?;
        let journal = self.plan_rename(from, to, snapshot)?;
        self.recovery.prepare_rename(&journal)?;
        if let Err(cause) = apply_rename(self.root(), &self.recovery, &journal) {
            // 提交标记若已持久化，清理故障不能再把成功的改名回滚。
            let committed = self
                .recovery
                .load_rename()
                .map_err(|err| Error::RenameRecovery {
                    detail: format!("提交失败：{cause}；无法读取提交状态：{err}。恢复记录已保留"),
                })?
                .is_some_and(|record| record.committed);
            if !committed {
                recover_pending(self.root(), &self.recovery).map_err(|err| {
                    Error::RenameRecovery {
                        detail: format!("提交失败：{cause}；{err}"),
                    }
                })?;
                return Err(cause);
            }
        }
        let mut warnings = Vec::new();
        if let Err(err) = recover_pending(self.root(), &self.recovery) {
            warnings.push(format!("改名记录清理失败，下次打开时会重试：{err}"));
        }
        if let Err(err) = self.remap_bookmarks_locked(from, to) {
            warnings.push(format!("书签路径未能更新：{err}"));
        }
        snapshot.apply_committed(&journal);
        Ok(RenameOutcome {
            warning: (!warnings.is_empty()).then(|| warnings.join("；")),
        })
    }

    fn check_rename_drafts(&self) -> Result<(), Error> {
        for path in self.check_entry_drafts(None)? {
            self.recovery.remove(&path)?;
        }
        Ok(())
    }

    fn plan_rename(
        &self,
        from: &str,
        to: &str,
        snapshot: &RenameSnapshot,
    ) -> Result<RenameJournal, Error> {
        let from_abs = resolve_in_root(self.root(), from)?;
        let to_abs = resolve_in_root(self.root(), to)?;
        if to_abs.starts_with(&from_abs) {
            return Err(Error::Io(io::Error::other("不能移动到自身的子文件夹")));
        }
        if fs::symlink_metadata(&to_abs).is_ok() {
            return Err(Error::AlreadyExists { path: to_abs });
        }
        let source = MoveSource::scan(self.root(), from)?;
        let directories = source.directories(self.root(), to)?;
        let files = &snapshot.files;
        let before = Inventory::with_extra(files.clone(), &snapshot.extras);
        let after_extras: HashMap<String, Vec<String>> = snapshot
            .extras
            .iter()
            .map(|(path, keys)| (moved_path(path, from, to), keys.clone()))
            .collect();
        let after = Inventory::with_extra(
            files
                .iter()
                .map(|path| moved_path(path, from, to))
                .collect(),
            &after_extras,
        );
        let mut creates = Vec::new();
        let mut updates = Vec::new();
        let mut removes = Vec::new();
        let mut observed = Vec::new();
        let mut all = files.clone();
        all.extend(source.files.iter().cloned());
        all.sort();
        all.dedup();
        for path in &all {
            let moving = source.files.contains(path);
            if !moving && !path.to_lowercase().ends_with(".md") {
                continue;
            }
            let uncached;
            let document = if let Some(document) = snapshot.documents.get(path) {
                document
            } else {
                uncached = RenameDocument::scan(path, self.read(path)?).0;
                &uncached
            };
            let bytes = &document.bytes;
            let rewritten = rewrite_file(path, bytes, &document.links, from, to, &before, &after)?;
            if moving {
                let permissions = file_permissions(&resolve_in_root(self.root(), path)?)?;
                creates.push(FileChange {
                    path: moved_path(path, from, to),
                    before: None,
                    after: Some(rewritten),
                    permissions,
                    started: false,
                });
                removes.push(FileChange {
                    path: path.clone(),
                    before: Some(bytes.clone()),
                    after: None,
                    permissions,
                    started: false,
                });
            } else if rewritten != *bytes {
                let permissions = file_permissions(&resolve_in_root(self.root(), path)?)?;
                updates.push(FileChange {
                    path: path.clone(),
                    before: Some(bytes.clone()),
                    after: Some(rewritten),
                    permissions,
                    started: false,
                });
            }
            observed.push((path.as_str(), document.hash));
        }
        self.verify_rename_snapshot(&observed)?;
        source.verify()?;
        if self.scan_files()? != *files {
            return Err(Error::Io(io::Error::other("库文件集合已变化，请重试改名")));
        }
        creates.extend(updates);
        creates.extend(removes);
        Ok(RenameJournal {
            from: from.to_string(),
            to: to.to_string(),
            committed: false,
            changes: creates,
            directories,
            created_directories: BTreeSet::new(),
        })
    }
}

/// 只检查真实路径祖先，避免预检每项目标都遍历整批源路径，也不误判相似名称。
fn contains_source_ancestor(
    mut path: Option<&Path>,
    sources: &BTreeSet<String>,
) -> Result<bool, Error> {
    while let Some(ancestor) = path.filter(|path| !path.as_os_str().is_empty()) {
        if sources.contains(&path_to_slashes(ancestor)?) {
            return Ok(true);
        }
        path = ancestor.parent();
    }
    Ok(false)
}

fn rewrite_file(
    path: &str,
    bytes: &[u8],
    links: &[LinkRecord],
    from: &str,
    to: &str,
    before: &Inventory,
    after: &Inventory,
) -> Result<Vec<u8>, Error> {
    let Ok(source) = std::str::from_utf8(bytes) else {
        return Ok(bytes.to_vec());
    };
    let mut edits = Vec::new();
    for link in links.iter().rev() {
        let Some(target) = resolve_against(before, path, &link.to_raw, link.kind) else {
            continue;
        };
        let new_source = moved_path(path, from, to);
        let new_target = moved_path(&target, from, to);
        if target == new_target && (path == new_source || link.kind != LinkKind::Markdown) {
            continue;
        }
        let target_text = match link.kind {
            LinkKind::Wiki => {
                let (original_target, _) = crate::link::split_resource(link.to_raw.trim());
                if original_target.contains('/') {
                    // 路径形式保持路径形式：无歧义，不参与名称唯一性检查。
                    crate::rewrite::wiki_target_path(original_target, &new_target)
                } else {
                    let stem = crate::rewrite::wiki_target_name(&new_target);
                    if resolve_against(after, &new_source, &stem, LinkKind::Wiki).as_deref()
                        != Some(new_target.as_str())
                    {
                        return Err(Error::Io(io::Error::other(
                            "目标名称会使现有 wiki 链接产生歧义，请换一个名称",
                        )));
                    }
                    stem
                }
            }
            LinkKind::Markdown => crate::rewrite::relative_markdown_url(&new_source, &new_target)?,
        };
        let start = usize::try_from(link.start_byte)
            .map_err(|_| Error::Io(io::Error::other("链接起点溢出")))?;
        let end = usize::try_from(link.end_byte)
            .map_err(|_| Error::Io(io::Error::other("链接终点溢出")))?;
        let span = source
            .get(start..end)
            .ok_or_else(|| Error::Io(io::Error::other("链接区间无效")))?;
        let replacement = crate::rewrite::rewrite_span(link.kind, span, &target_text)?;
        let prefix = span
            .bytes()
            .zip(replacement.bytes())
            .take_while(|(left, right)| left == right)
            .count();
        let suffix = span.as_bytes()[prefix..]
            .iter()
            .rev()
            .zip(replacement.as_bytes()[prefix..].iter().rev())
            .take_while(|(left, right)| left == right)
            .count();
        edits.push((
            start + prefix,
            end - suffix,
            replacement.as_bytes()[prefix..replacement.len() - suffix].to_vec(),
        ));
    }
    edits.sort_by_key(|(start, _, _)| *start);
    if edits.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(Error::Io(io::Error::other("链接修改区间重叠，已停止改名")));
    }
    let mut rewritten = bytes.to_vec();
    for (start, end, replacement) in edits.into_iter().rev() {
        rewritten.splice(start..end, replacement);
    }
    Ok(rewritten)
}

pub(super) fn recover_pending(root: &Path, store: &RecoveryStore) -> Result<(), Error> {
    let Some(journal) = store.load_rename()? else {
        return Ok(());
    };
    if !journal.committed {
        for change in journal.changes.iter().rev().filter(|change| change.started) {
            rollback_file(root, change).map_err(|err| Error::RenameRecovery {
                detail: format!(
                    "{} → {}，恢复 {} 受阻：{err}。原始内容仍保留在恢复记录中",
                    journal.from, journal.to, change.path
                ),
            })?;
        }
        for directory in journal
            .directories
            .iter()
            .rev()
            .filter(|path| journal.created_directories.contains(*path))
        {
            let path = resolve_in_root(root, directory)?;
            match fs::remove_dir(&path) {
                Ok(()) => sync_parent(&path)?,
                Err(err)
                    if matches!(
                        err.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(err) => {
                    return Err(Error::RenameRecovery {
                        detail: format!("清理目录 {directory} 受阻：{err}"),
                    });
                }
            }
        }
    }
    if journal.committed {
        // 只删除本次移动的空源目录；期间新增的外部文件必须保留，不能递归删除。
        for directory in journal.directories.iter().rev() {
            if directory != &journal.to && !directory.starts_with(&format!("{}/", journal.to)) {
                continue;
            }
            let original = moved_path(directory, &journal.to, &journal.from);
            let path = resolve_in_root(root, &original)?;
            match fs::remove_dir(&path) {
                Ok(()) => sync_parent(&path)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(Error::RenameRecovery {
                        detail: format!("文件已移动，旧目录 {original} 清理受阻：{error}"),
                    });
                }
            }
        }
    }
    store.clear_rename()
}

fn moved_path(path: &str, from: &str, to: &str) -> String {
    if path == from {
        to.to_string()
    } else if let Some(suffix) = path.strip_prefix(&format!("{from}/")) {
        format!("{to}/{suffix}")
    } else {
        path.to_string()
    }
}

fn rollback_file(root: &Path, change: &FileChange) -> Result<(), Error> {
    let path = resolve_in_root(root, &change.path)?;
    if read_optional(&path)?.as_deref() == change.before.as_deref() {
        if path.parent().is_some_and(Path::exists) {
            sync_parent(&path)?;
        }
        return Ok(());
    }
    let path = replace_version(
        root,
        change,
        change.after.as_deref(),
        change.before.as_deref(),
    )?;
    // 恢复逐步落盘，日志只会在所有原始版本均已恢复后清理。
    sync_parent(&path)?;
    Ok(())
}

fn check_version(path: &Path, expected: Option<&[u8]>) -> Result<(), Error> {
    if read_optional(path)?.as_deref() != expected {
        return Err(Error::FileChanged {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn relative_path(root: &Path, rel: &str) -> Result<String, Error> {
    let path = resolve_in_root(root, rel)?;
    path_to_slashes(path.strip_prefix(root).map_err(|_| Error::PathEscape)?)
}

fn file_permissions(path: &Path) -> Result<u32, Error> {
    let permissions = fs::metadata(path)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(permissions.mode())
    }
    #[cfg(not(unix))]
    {
        Ok(u32::from(permissions.readonly()))
    }
}

/// 从日志恢复最终权限，交由暂存写入在同一次文件同步前设置。
fn version_permissions(parent: &Path, mode: u32) -> Result<fs::Permissions, Error> {
    let mut permissions = fs::metadata(parent)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(mode);
    }
    #[cfg(not(unix))]
    {
        permissions.set_readonly(mode != 0);
    }
    Ok(permissions)
}

/// 提交后的派生错误只能追加为警告，不能改变已经成功的文件归属。
fn append_warning(warning: &mut Option<String>, message: String) {
    match warning {
        Some(previous) => {
            previous.push('；');
            previous.push_str(&message);
        }
        None => *warning = Some(message),
    }
}
