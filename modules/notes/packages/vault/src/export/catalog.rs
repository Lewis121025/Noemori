//! 链接身份从本次读取的正文构建；搜索索引的容错结果与更新时间不能作为导出凭据。
use super::files::{self, Identity};
use crate::vault::Inventory;
use crate::{EntryKind, Error, LinkKind, LinkTarget, VaultEntry};
use std::{
    collections::{BTreeMap, HashMap},
    io::Read,
    path::Path,
};

/// 身份表只保存路径、标题、别名和版本；每篇原文在解析后立即释放。
pub(super) struct Catalog {
    inventory: Inventory,
    entries: Vec<VaultEntry>,
    versions: BTreeMap<String, (Identity, String, u64)>,
}

impl Catalog {
    pub fn capture(
        root: &Path,
        progress: &mut dyn FnMut(usize) -> Result<(), Error>,
    ) -> Result<Self, Error> {
        let entries = files::selected_entries(root, None, false, false, progress)?;
        let paths: Vec<_> = entries
            .iter()
            .filter(|entry| entry.kind == EntryKind::File)
            .map(|entry| entry.path.clone())
            .collect();
        let mut versions = BTreeMap::new();
        let mut extras = HashMap::new();
        for path in &paths {
            progress(0)?;
            if !path.to_lowercase().ends_with(".md") {
                continue;
            }
            let mut file = files::open_source(root, path)?;
            let before = Identity::read(&file)?;
            // 身份扫描与正文转换使用同一有界单篇预算，附件始终流式处理。
            if before.len > 64 * 1024 * 1024 {
                return Err(files::failure(format!("笔记超过 64 MiB 解析预算：{path}")));
            }
            let mut bytes = Vec::new();
            file.by_ref()
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if before != Identity::read(&file)? || bytes.len() as u64 != before.len {
                return Err(files::failure(format!("链接身份读取期间内容变化：{path}")));
            }
            if let Ok(source) = std::str::from_utf8(&bytes) {
                let keys = crate::markdown::scan::scan_identity_strict(source)
                    .map_err(|e| files::failure(format!("无法严格解析 {path}：{e}")))?;
                extras.insert(path.clone(), keys);
            }
            // 非 UTF-8 原文件没有可解析的标题；原格式仍可保留字节，转换入口另行拒绝。
            let hash = files::hash_bytes(&bytes);
            let size = before.len;
            versions.insert(path.clone(), (before, hash, size));
        }
        Ok(Self {
            inventory: Inventory::with_extra(paths, &extras),
            entries,
            versions,
        })
    }

    pub fn resolve(&self, from: &str, raw: &str, kind: LinkKind) -> LinkTarget {
        crate::vault::resolve_target(&self.inventory, from, raw, kind)
    }

    pub fn check_version(&self, path: &str, hash: &str, bytes: u64) -> Result<(), Error> {
        if self
            .versions
            .get(path)
            .is_some_and(|(_, expected, size)| hash != expected || bytes != *size)
        {
            return Err(files::failure(format!("正文与链接身份版本不一致：{path}")));
        }
        Ok(())
    }

    pub fn verify(
        &self,
        root: &Path,
        progress: &mut dyn FnMut(usize) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if self.entries != files::selected_entries(root, None, false, false, progress)? {
            return Err(files::failure("链接目标清单发生变化，请重新导出"));
        }
        for (path, (identity, hash, size)) in &self.versions {
            let mut file = files::open_source(root, path)?;
            if &Identity::read(&file)? != identity
                || files::hash_reader(&mut file, progress)? != (hash.clone(), *size)
                || &Identity::read(&file)? != identity
            {
                return Err(files::failure(format!("链接身份版本发生变化：{path}")));
            }
        }
        Ok(())
    }
}
