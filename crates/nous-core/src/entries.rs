//! 文件管理使用同一库根约束和写入锁，系统废纸篓由原生适配层提供。
use crate::pathutil::{path_to_slashes, resolve_in_root, validate_relative_path};
use crate::save::{read_optional, stage, sync_parent};
use crate::{Error, RenameOutcome, Vault};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 目录树中的磁盘条目类型；符号链接不作为可操作条目暴露。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
}

/// 库内条目，路径使用正斜杠，目录包含空目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultEntry {
    /// 库内相对路径。
    pub path: String,
    /// 文件或目录。
    pub kind: EntryKind,
    /// 原路径被其他类型条目占用或不可安全访问，草稿须单独显示，不能伪装成磁盘条目。
    pub recovery_only: bool,
}

/// 批量操作的独立源条目；目标缺席表示移入系统废纸篓。
pub struct EntryMutation {
    /// 规范的库内源路径，不得与本批其他源形成父子关系。
    pub from: String,
    /// 移动目标；父目录必须已经存在。
    pub to: Option<String>,
}

impl Vault {
    /// 列出可见文件、空目录和可恢复草稿。
    /// # Errors
    /// 目录缓存、恢复记录不可读时失败。
    pub fn list_entries(&self) -> Result<Vec<VaultEntry>, Error> {
        let files: HashSet<_> = self.list_disk_files()?.into_iter().collect();
        let mut entries: Vec<_> = files
            .iter()
            .map(|path| VaultEntry {
                path: path.clone(),
                kind: EntryKind::File,
                recovery_only: false,
            })
            .collect();
        entries.extend(self.directory_paths()?.into_iter().map(|path| VaultEntry {
            path,
            kind: EntryKind::Directory,
            recovery_only: false,
        }));
        for path in self.recovery.paths()? {
            if files.contains(&path) {
                continue;
            }
            let recovery_only = match resolve_in_root(self.root(), &path)
                .and_then(|resolved| fs::metadata(resolved).map_err(Error::from))
            {
                Ok(metadata) => !metadata.is_file(),
                Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => false,
                Err(_) => true,
            };
            entries.push(VaultEntry {
                path,
                kind: EntryKind::File,
                recovery_only,
            });
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    /// 独占创建笔记或单个文件夹，父目录必须已存在，不覆盖任何条目。
    ///
    /// `content` 是文件的初始字节（空切片即空文件）；创建与写入是同一次
    /// 独占提交，磁盘上不存在「先空文件、后补内容」的中间窗口。
    /// # Errors
    /// 名称非法、父目录不存在、目标已存在、草稿路径冲突、目录携带内容
    /// 或恢复事务受阻时失败。
    pub fn create_entry(
        &self,
        rel: &str,
        kind: EntryKind,
        content: &[u8],
    ) -> Result<RenameOutcome, Error> {
        let _guard = self.lock_writes()?;
        crate::rename::recover_pending(self.root(), &self.recovery)?;
        validate_entry_path(rel)?;
        let path = resolve_in_root(self.root(), rel)?;
        if !path.parent().is_some_and(Path::is_dir) {
            return Err(Error::Io(io::Error::other("父文件夹不存在")));
        }
        if fs::symlink_metadata(&path).is_ok() {
            return Err(Error::AlreadyExists { path });
        }
        if let Some(draft) = self.recovery.conflicting_path(rel, kind, None)? {
            return Err(Error::Io(io::Error::other(format!(
                "路径被恢复草稿占用，请先处理：{draft}"
            ))));
        }
        match kind {
            EntryKind::File => {
                stage(&path, content)?
                    .persist_noclobber(&path)
                    .map_err(|error| error.error)?;
            }
            EntryKind::Directory => {
                if !content.is_empty() {
                    return Err(Error::Io(io::Error::other("文件夹不能携带初始内容")));
                }
                fs::create_dir(&path)?;
            }
        }
        Ok(self.finish_entry(&path))
    }

    /// 将条目交给系统废纸篓；不提供永久删除回退，也不删除未处理的编辑草稿。
    /// `trash` 只接收经过库根校验的路径，必须在成功移走后返回 Ok。
    /// # Errors
    /// 库根、符号链接、越界、草稿冲突或系统废纸篓失败时返回错误。
    pub fn trash_entry(
        &self,
        rel: &str,
        trash: impl FnOnce(&Path) -> Result<(), Error>,
    ) -> Result<RenameOutcome, Error> {
        let _guard = self.lock_writes()?;
        crate::rename::recover_pending(self.root(), &self.recovery)?;
        let path = self.entry_path(rel)?;
        for draft_path in self.check_entry_drafts(Some(&path))? {
            self.recovery.remove(&draft_path)?;
        }
        trash(&path)?;
        Ok(self.finish_entry(&path))
    }

    /// 校验相关草稿并返回已提交的记录；预检仅校验，实际操作才清理这些记录。
    pub(super) fn check_entry_drafts(&self, ancestor: Option<&Path>) -> Result<Vec<String>, Error> {
        let mut committed = Vec::new();
        for draft_path in self.recovery.paths()? {
            // 先按路径归属筛选，其他目录的恢复问题不应阻止整理无关条目。
            let absolute = self.root().join(validate_relative_path(&draft_path)?);
            if ancestor.is_some_and(|path| !absolute.starts_with(path)) {
                continue;
            }
            let draft_abs = resolve_in_root(self.root(), &draft_path)?;
            if let Some(draft) = self.recovery.get(&draft_path)? {
                if !draft.is_committed(read_optional(&draft_abs)?.as_deref()) {
                    return Err(Error::Io(io::Error::other(format!(
                        "请先处理未保存草稿：{draft_path}"
                    ))));
                }
                committed.push(draft_path);
            }
        }
        Ok(committed)
    }

    /// 返回可供系统文件管理器显示的现有条目路径。
    /// # Errors
    /// 非库内条目、符号链接或路径不存在时失败，绝不返回任意外部路径。
    pub fn entry_path(&self, rel: &str) -> Result<PathBuf, Error> {
        let path = resolve_in_root(self.root(), rel)?;
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(Error::PathEscape);
        }
        Ok(path)
    }

    pub(super) fn finish_entry(&self, path: &Path) -> RenameOutcome {
        let mut warnings = Vec::new();
        if let Err(error) = sync_parent(path) {
            warnings.push(format!("目录同步失败：{error}"));
        }
        if let Err(error) = self.refresh_index_locked() {
            warnings.push(format!("索引刷新失败：{error}"));
        }
        RenameOutcome {
            warning: (!warnings.is_empty()).then(|| warnings.join("；")),
        }
    }
}

pub(super) fn validate_entry_path(rel: &str) -> Result<(), Error> {
    if rel.is_empty()
        || rel.split('/').any(|name| {
            name.is_empty()
                || name != name.trim()
                || name.starts_with('.')
                || name.ends_with('.')
                || name
                    .chars()
                    .any(|ch| ch.is_control() || "\\:*?\"<>|".contains(ch))
        })
    {
        return Err(Error::Io(io::Error::other(
            "名称不能为空、以点开头或包含路径分隔符等无效字符",
        )));
    }
    for name in rel.split('/') {
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(Error::Io(io::Error::other(
                "此名称被系统保留，请换一个名称",
            )));
        }
    }
    Ok(())
}

/// 浏览时跳过不可管理条目；移动扫描包含隐藏内容，并拒绝无法完整迁移的条目。
pub(super) fn scan_entries(root: &Path, include_hidden: bool) -> Result<Vec<VaultEntry>, Error> {
    fn visit(
        root: &Path,
        directory: &Path,
        include_hidden: bool,
        entries: &mut Vec<VaultEntry>,
    ) -> Result<(), Error> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if !include_hidden && entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                if include_hidden {
                    return Err(Error::Io(io::Error::other(
                        "文件夹包含符号链接，不能整体移动",
                    )));
                }
                continue;
            }
            if !kind.is_dir() && !kind.is_file() {
                if include_hidden {
                    return Err(Error::Io(io::Error::other("文件夹包含不支持的特殊文件")));
                }
                continue;
            }
            let path = path_to_slashes(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| Error::PathEscape)?,
            )?;
            entries.push(VaultEntry {
                path,
                kind: if kind.is_dir() {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
                recovery_only: false,
            });
            if kind.is_dir() {
                visit(root, &entry.path(), include_hidden, entries)?;
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, include_hidden, &mut entries)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}
