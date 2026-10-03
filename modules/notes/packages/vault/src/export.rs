//! 导出只读取已保存内容；冻结副本与来源校验共同保证转换不混用文件版本。

mod catalog;
mod files;

use crate::storage::path::{resolve_in_root, validate_relative_path};
use crate::vault::hex_digest;
use crate::{EntryKind, Error, LinkKind, LinkTarget, Vault, VaultEntry};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use unicode_normalization::UnicodeNormalization;

/// 导出源文件数量上限；目录不占文件预算。
pub const EXPORT_FILE_LIMIT: usize = 10_000;
/// 源文件与远程资源合计的未压缩预算。
pub const EXPORT_BYTE_LIMIT: u64 = 5 * 1024 * 1024 * 1024;

/// 已冻结文件的身份；哈希对应快照字节而非可变索引。
#[derive(Clone, Debug, Serialize)]
pub struct ExportFile {
    /// 库内相对路径。
    pub path: String,
    /// 原始字节数。
    pub bytes: u64,
    /// SHA-256 的十六进制编码。
    pub hash: String,
}

/// 一次任务独占的源快照；析构只删除自身暂存目录，不修改笔记库。
pub struct ExportSnapshot {
    root: PathBuf,
    canonical_root: PathBuf,
    directory: TempDir,
    catalog: catalog::Catalog,
    selected: Option<Vec<String>>,
    hidden: bool,
    entries: Vec<VaultEntry>,
    files: BTreeMap<String, ExportFile>,
    identities: BTreeMap<String, files::Identity>,
    directories: HashSet<String>,
    total: u64,
    sealed: bool,
}

impl Vault {
    /// 冻结选择内的原始文件；空选择非法，None 表示整个库。
    /// # Errors
    /// 草稿未处理、路径非法、源变化、预算超限或取消时拒绝整项任务。
    pub fn export_snapshot(
        &self,
        selection: Option<Vec<String>>,
        hidden: bool,
        staging_parent: &Path,
        progress: &mut dyn FnMut(usize) -> Result<(), Error>,
    ) -> Result<ExportSnapshot, Error> {
        // 选择项包含目录及父子重叠；一万文件预算由去重后的实际枚举执行。
        let selection = selection.map(|paths| {
            paths
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        });
        if let Some(paths) = &selection {
            if paths.is_empty() {
                return Err(files::failure("导出选择为空"));
            }
            for path in paths {
                validate_relative_path(path)?;
            }
        }
        if fs::symlink_metadata(self.root())?.file_type().is_symlink() {
            return Err(files::failure("库根不能是符号链接"));
        }
        // macOS 的 /var 等系统祖先可含合法别名，只在任务创建时解析一次。
        let canonical_root = self.root().canonicalize()?;
        let entries = files::selected_entries(
            &canonical_root,
            selection.as_deref(),
            hidden,
            true,
            progress,
        )?;
        let _guard = self.lock_writes()?;
        let catalog = catalog::Catalog::capture(&canonical_root, progress)?;
        let mut snapshot = ExportSnapshot {
            root: self.root().to_path_buf(),
            canonical_root,
            directory: tempfile::Builder::new()
                .prefix("source-")
                .tempdir_in(staging_parent)?,
            catalog,
            selected: selection,
            hidden,
            entries,
            files: BTreeMap::new(),
            identities: BTreeMap::new(),
            directories: HashSet::new(),
            total: 0,
            sealed: false,
        };
        snapshot.check_drafts(self)?;
        let entries = snapshot.entries.clone();
        for entry in entries {
            progress(snapshot.files.len())?;
            if entry.kind == EntryKind::Directory {
                fs::create_dir_all(snapshot.directory.path().join(&entry.path))?;
                snapshot.directories.insert(entry.path);
            } else {
                snapshot.capture(self, &entry.path, progress)?;
            }
        }
        Ok(snapshot)
    }
}

impl ExportSnapshot {
    /// 显式清理可以报告磁盘错误；析构仅作为异常路径的后备。
    /// # Errors
    /// 暂存目录无法删除。
    pub fn close(self) -> Result<(), Error> {
        self.directory.close().map_err(Error::from)
    }
    /// 返回冻结源目录；仅提供给可信宿主，不经渲染进程 IPC 暴露。
    #[must_use]
    pub fn directory(&self) -> &Path {
        self.directory.path()
    }
    /// 返回源库身份，用于阻止导出覆盖源目录。
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }
    /// 返回确定顺序的文件清单。
    #[must_use]
    pub fn files(&self) -> Vec<ExportFile> {
        self.files.values().cloned().collect()
    }
    /// 已冻结的文件数，预算核验无需复制完整清单。
    #[must_use]
    pub fn file_count(&self) -> usize {
        self.files.len()
    }
    /// 单文件身份用于流式复制后的哈希比对。
    #[must_use]
    pub fn file(&self, path: &str) -> Option<&ExportFile> {
        self.files.get(path)
    }
    /// 返回需要保留的空目录和父目录。
    #[must_use]
    pub fn directories(&self) -> Vec<String> {
        let mut paths: Vec<_> = self.directories.iter().cloned().collect();
        paths.sort();
        paths
    }
    /// 已冻结字节量，远程下载仍需计入同一预算。
    #[must_use]
    pub fn bytes(&self) -> u64 {
        self.total
    }
    /// 使用开始任务时的解析表，避免后续索引变化影响链接目标。
    #[must_use]
    pub fn resolve(&self, from: &str, raw: &str, kind: LinkKind) -> LinkTarget {
        self.catalog.resolve(from, raw, kind)
    }

    /// 收集显式依赖，重复资源保持同一快照；封存后禁止追加。
    /// # Errors
    /// 草稿、源变化、越界、重复身份冲突、预算或读取失败。
    pub fn include(
        &mut self,
        vault: &Vault,
        path: &str,
        progress: &mut dyn FnMut(usize) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if self.sealed {
            return Err(files::failure("导出快照已经封存"));
        }
        if self.files.contains_key(path) {
            return Ok(());
        }
        let _guard = vault.lock_writes()?;
        self.capture(vault, path, progress)
    }

    fn capture(
        &mut self,
        vault: &Vault,
        path: &str,
        progress: &mut dyn FnMut(usize) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.check_root(vault)?;
        if self.files.contains_key(path) {
            return Ok(());
        }
        validate_relative_path(path)?;
        if self.files.len() >= EXPORT_FILE_LIMIT {
            return Err(files::failure("导出超过 10000 个文件"));
        }
        let mut source = files::open_source(&self.canonical_root, path)?;
        let identity = files::Identity::read(&source)?;
        if identity.len > EXPORT_BYTE_LIMIT - self.total {
            return Err(files::failure("导出源数据超过 5 GiB"));
        }
        if let Some(draft) = vault.recovery.get(path)? {
            // 草稿已提交但清理失败时允许继续；不能把 editor 恢复记录当作已保存字节。
            if draft.editor.is_some()
                || files::hash_bytes(&draft.bytes) != files::hash_reader(&mut source, progress)?.0
            {
                return Err(files::failure(format!("请先恢复并保存草稿：{path}")));
            }
        }
        let destination = self.directory.path().join(path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let (hash, size) = files::copy_source(&mut source, &destination, progress)?;
        if identity != files::Identity::read(&source)? || size != identity.len {
            return Err(files::failure(format!(
                "导出读取期间源文件发生变化：{path}"
            )));
        }
        self.catalog.check_version(path, &hash, size)?;
        self.total += size;
        self.identities.insert(path.to_string(), identity);
        self.files.insert(
            path.to_string(),
            ExportFile {
                path: path.to_string(),
                bytes: size,
                hash,
            },
        );
        Ok(())
    }

    fn check_drafts(&self, vault: &Vault) -> Result<(), Error> {
        for path in vault.recovery.paths()? {
            if self.selected.as_ref().is_none_or(|paths| {
                paths
                    .iter()
                    .any(|p| path == *p || path.starts_with(&format!("{p}/")))
            }) && !self
                .entries
                .iter()
                .any(|entry| entry.path == path && entry.kind == EntryKind::File)
            {
                return Err(files::failure(format!(
                    "导出范围包含尚未恢复的草稿：{path}"
                )));
            }
        }
        Ok(())
    }

    fn check_root(&self, vault: &Vault) -> Result<(), Error> {
        if vault.root() != self.root
            || fs::symlink_metadata(&self.root)?.file_type().is_symlink()
            || self.root.canonicalize()? != self.canonical_root
        {
            return Err(files::failure("导出所属笔记库已变化"));
        }
        Ok(())
    }

    /// 完成源清单、身份、字节和恢复记录核对；此后转换只读快照。
    /// # Errors
    /// 任一源内容或目录变化、未处理草稿、取消或读取失败。
    pub fn seal(
        &mut self,
        vault: &Vault,
        progress: &mut dyn FnMut(usize) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if self.sealed {
            return Ok(());
        }
        let _guard = vault.lock_writes()?;
        self.check_root(vault)?;
        self.check_drafts(vault)?;
        self.catalog.verify(&self.canonical_root, progress)?;
        if self.entries
            != files::selected_entries(
                &self.canonical_root,
                self.selected.as_deref(),
                self.hidden,
                true,
                progress,
            )?
        {
            return Err(files::failure("导出范围内的文件清单发生变化，请重新导出"));
        }
        for (index, (path, record)) in self.files.iter().enumerate() {
            progress(index)?;
            let mut source = files::open_source(&self.canonical_root, path)?;
            if self.identities.get(path) != Some(&files::Identity::read(&source)?)
                || files::hash_reader(&mut source, progress)? != (record.hash.clone(), record.bytes)
            {
                return Err(files::failure(format!("导出源版本发生变化：{path}")));
            }
            if let Some(draft) = vault.recovery.get(path)? {
                if draft.editor.is_some() || files::hash_bytes(&draft.bytes) != record.hash {
                    return Err(files::failure(format!("导出源包含未保存草稿：{path}")));
                }
            }
        }
        self.sealed = true;
        Ok(())
    }

    /// 读取冻结文件的可信路径；不存在或未收集的路径不能访问。
    /// # Errors
    /// 路径不属于任务或越界。
    pub fn file_path(&self, path: &str) -> Result<PathBuf, Error> {
        if !self.files.contains_key(path) {
            return Err(files::failure("文件不属于导出快照"));
        }
        resolve_in_root(self.directory.path(), path)
    }

    /// 原格式不能为避让而改名；提前拒绝在常见 macOS 文件系统上冲突的名字。
    /// # Errors
    /// 两个路径按 Unicode 规范化和大小写折叠后相同。
    pub fn check_original_names(&self) -> Result<(), Error> {
        let mut names = HashSet::new();
        for path in self.files.keys().chain(self.directories.iter()) {
            if !names.insert(name_key(path)) {
                return Err(files::failure(format!(
                    "原格式路径存在大小写或 Unicode 冲突：{path}"
                )));
            }
        }
        Ok(())
    }
}

// Unicode 规范等价与完整大小写折叠须同时处理，普通小写转换会漏掉 ß、末尾 sigma 等。
fn name_key(path: &str) -> String {
    icu_casemap::CaseMapper::new()
        .fold_string(&path.nfd().collect::<String>())
        .nfd()
        .collect()
}

#[cfg(test)]
#[path = "../../../../../test/notes/vault/unit/storage/export_names.rs"]
mod name_tests;

/// 对已批准路径计算流式 SHA-256，供归档验证复用。
/// # Errors
/// 读取或进度回调失败。
pub fn export_file_hash(
    path: &Path,
    progress: &mut dyn FnMut(usize) -> Result<(), Error>,
) -> Result<(String, u64), Error> {
    files::hash_reader(&mut fs::File::open(path)?, progress)
}
