//! 移动源的完整快照：显示列表可忽略隐藏条目，移动事务必须保留它们和空目录。

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::entries::scan_entries;
use crate::pathutil::{path_to_slashes, resolve_in_root};
use crate::{EntryKind, Error, VaultEntry};

/// 同一次规划内的源条目集合；提交前复查目录快照以拒绝遗漏外部新增文件。
pub(super) struct MoveSource {
    absolute: PathBuf,
    descendants: Option<Vec<VaultEntry>>,
    pub files: BTreeSet<String>,
}

impl MoveSource {
    /// 扫描库内源路径；隐藏内容也纳入事务，符号链接和特殊条目必须明确拒绝。
    pub fn scan(root: &Path, from: &str) -> Result<Self, Error> {
        let absolute = resolve_in_root(root, from)?;
        let metadata = fs::metadata(&absolute)?;
        let descendants = if metadata.is_dir() {
            Some(scan_entries(&absolute, true)?)
        } else if metadata.is_file() {
            None
        } else {
            return Err(Error::Io(io::Error::other("不支持移动此类条目")));
        };
        let files = descendants.as_ref().map_or_else(
            || BTreeSet::from([from.to_string()]),
            |entries| {
                entries
                    .iter()
                    .filter(|entry| entry.kind == EntryKind::File)
                    .map(|entry| format!("{from}/{}", entry.path))
                    .collect()
            },
        );
        Ok(Self {
            absolute,
            descendants,
            files,
        })
    }

    /// 返回由浅到深的待建目录，包含空目录；已有父目录不归本次回滚所有。
    pub fn directories(&self, root: &Path, to: &str) -> Result<Vec<String>, Error> {
        let target = resolve_in_root(root, to)?;
        let mut directories = Vec::new();
        let mut parent = if self.descendants.is_some() {
            Some(target.as_path())
        } else {
            target.parent()
        };
        while let Some(path) = parent.filter(|path| !path.exists()) {
            directories.push(path_to_slashes(
                path.strip_prefix(root).map_err(|_| Error::PathEscape)?,
            )?);
            parent = path.parent();
        }
        if let Some(entries) = &self.descendants {
            directories.extend(
                entries
                    .iter()
                    .filter(|entry| entry.kind == EntryKind::Directory)
                    .map(|entry| format!("{to}/{}", entry.path)),
            );
        }
        directories.sort_by_key(|path| (path.matches('/').count(), path.clone()));
        directories.dedup();
        Ok(directories)
    }

    /// 规划完成后复查整个源目录；外部新增或删除会使计划失效并返回错误。
    pub fn verify(&self) -> Result<(), Error> {
        if let Some(entries) = &self.descendants {
            if &scan_entries(&self.absolute, true)? != entries {
                return Err(Error::Io(io::Error::other("文件夹内容已变化，请重试移动")));
            }
        }
        Ok(())
    }
}
