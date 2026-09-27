//! 根据实时内容生成改名计划，并以持久化日志恢复中断的文件提交。

mod source;

use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::Path;

use crate::pathutil::{path_to_slashes, resolve_in_root};
use crate::recovery::RecoveryStore;
use crate::rename_journal::{FileChange, RenameJournal};
use crate::save::{read_optional, stage, sync_parent};
use crate::vault::{resolve_against, Inventory};
use crate::{Error, LinkKind, Vault};
use source::MoveSource;

/// 文件已完成改名；派生索引和日志清理的失败不撤销已提交内容。
#[derive(Debug)]
pub struct RenameOutcome {
    /// 提交后的警告；没有待处理问题时为 `None`。
    pub warning: Option<String>,
}

impl Vault {
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
        let journal = self.plan_rename(&from, &to)?;
        self.recovery.prepare_rename(&journal)?;
        if let Err(cause) = self.apply_rename(&journal) {
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
        if let Err(err) = self.refresh_index_locked() {
            warnings.push(format!("链接索引更新失败：{err}"));
        }
        if let Err(err) = self.remap_bookmarks_locked(&from, &to) {
            warnings.push(format!("书签路径未能更新：{err}"));
        }
        Ok(RenameOutcome {
            warning: (!warnings.is_empty()).then(|| warnings.join("；")),
        })
    }

    fn check_rename_drafts(&self) -> Result<(), Error> {
        for path in self.recovery.paths()? {
            if let Some(draft) = self.recovery.get(&path)? {
                if !draft
                    .is_committed(read_optional(&resolve_in_root(self.root(), &path)?)?.as_deref())
                {
                    return Err(Error::Io(io::Error::other(format!(
                        "请先处理未保存草稿：{path}"
                    ))));
                }
                self.recovery.remove(&path)?;
            }
        }
        Ok(())
    }

    fn plan_rename(&self, from: &str, to: &str) -> Result<RenameJournal, Error> {
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
        let files = self.scan_files()?;
        // 身份和改写必须用同一次读取，避免两次读盘之间正文变了，歧义判断和写入各看各的。
        let snapshot = self.read_markdown_snapshot(&files)?;
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
            let bytes = snapshot
                .bytes
                .get(path)
                .cloned()
                .map_or_else(|| self.read(path), Ok)?;
            let rewritten = if path.to_lowercase().ends_with(".md") {
                rewrite_file(path, &bytes, from, to, &before, &after)?
            } else {
                bytes.clone()
            };
            let permissions = file_permissions(&resolve_in_root(self.root(), path)?)?;
            if moving {
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
            } else if rewritten != bytes {
                updates.push(FileChange {
                    path: path.clone(),
                    before: Some(bytes.clone()),
                    after: Some(rewritten),
                    permissions,
                    started: false,
                });
            }
            observed.push((path, Sha256::digest(&bytes)));
        }
        for (path, digest) in observed {
            if Sha256::digest(self.read(path)?) != digest {
                return Err(Error::FileChanged {
                    path: resolve_in_root(self.root(), path)?,
                });
            }
        }
        source.verify()?;
        if self.scan_files()? != files {
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

    /// 一次读完 Markdown，同时给出身份键和即将改写的字节。
    ///
    /// 读失败直接返回，不再吞掉错误后用另一份内容继续改名。
    fn read_markdown_snapshot(&self, files: &[String]) -> Result<MarkdownSnapshot, Error> {
        let mut bytes = HashMap::new();
        let mut extras = HashMap::new();
        for path in files {
            if !crate::vault::is_markdown(path) {
                continue;
            }
            let read = self.read(path)?;
            if let Ok(text) = std::str::from_utf8(&read) {
                let keys = crate::identity::keys_from_scan(&crate::scan::scan_markdown(path, text));
                if !keys.is_empty() {
                    extras.insert(path.clone(), keys);
                }
            }
            bytes.insert(path.clone(), read);
        }
        Ok(MarkdownSnapshot { extras, bytes })
    }

    fn apply_rename(&self, journal: &RenameJournal) -> Result<(), Error> {
        for directory in &journal.directories {
            create_move_directory(self.root(), &self.recovery, journal, directory)?;
        }
        for (ordinal, change) in journal.changes.iter().enumerate() {
            self.recovery.start_rename_step(ordinal)?;
            let mut written = false;
            let result = replace_version(
                self.root(),
                change,
                change.before.as_deref(),
                change.after.as_deref(),
                &mut written,
            );
            if result.is_err() && !written {
                self.recovery.cancel_rename_step(ordinal)?;
            }
            result?;
        }
        for directory in journal.directories.iter().rev() {
            sync_parent(&resolve_in_root(self.root(), directory)?)?;
        }
        self.recovery.commit_rename()
    }
}

/// 改名计划用的 Markdown 快照：身份键和正文来自同一次读取。
struct MarkdownSnapshot {
    extras: HashMap<String, Vec<String>>,
    bytes: HashMap<String, Vec<u8>>,
}

fn create_move_directory(
    root: &Path,
    store: &RecoveryStore,
    journal: &RenameJournal,
    directory: &str,
) -> Result<(), Error> {
    let path = resolve_in_root(root, directory)?;
    let original = moved_path(directory, &journal.to, &journal.from);
    let permissions = if original == directory {
        None
    } else {
        Some(fs::metadata(resolve_in_root(root, &original)?)?.permissions())
    };
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    if let Some(permissions) = &permissions {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        // 创建时就限制访问，不能短暂将私有目录暴露为系统默认权限。
        builder.mode(permissions.mode());
    }
    builder.create(&path)?;
    // mkdir 与 SQLite 无法原子提交；中间退出时保留未确认的空目录，不能推测归属并删除。
    if let Err(cause) = store.record_created_directory(directory) {
        fs::remove_dir(&path).map_err(|error| Error::RenameRecovery {
            detail: format!("目录归属记录失败：{cause}；清理 {directory} 失败：{error}"),
        })?;
        sync_parent(&path)?;
        return Err(cause);
    }
    if let Some(permissions) = permissions {
        fs::set_permissions(&path, permissions)?;
    }
    Ok(())
}

fn rewrite_file(
    path: &str,
    bytes: &[u8],
    from: &str,
    to: &str,
    before: &Inventory,
    after: &Inventory,
) -> Result<Vec<u8>, Error> {
    let Ok(source) = std::str::from_utf8(bytes) else {
        return Ok(bytes.to_vec());
    };
    let links = crate::scan::scan_markdown(path, source).links;
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
    replace_version(
        root,
        change,
        change.after.as_deref(),
        change.before.as_deref(),
        &mut false,
    )
}

fn replace_version(
    root: &Path,
    change: &FileChange,
    expected: Option<&[u8]>,
    desired: Option<&[u8]>,
    written: &mut bool,
) -> Result<(), Error> {
    let path = resolve_in_root(root, &change.path)?;
    check_version(&path, expected)?;
    if let Some(bytes) = desired {
        let file = stage(&path, bytes)?;
        set_permissions(file.as_file(), change.permissions)?;
        file.as_file().sync_all()?;
        check_version(&path, expected)?;
        if expected.is_none() {
            file.persist_noclobber(&path).map_err(|err| err.error)?;
        } else {
            file.persist(&path).map_err(|err| err.error)?;
        }
    } else {
        fs::remove_file(&path)?;
    }
    *written = true;
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

fn set_permissions(file: &fs::File, mode: u32) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(mode != 0);
        file.set_permissions(permissions)?;
    }
    Ok(())
}
