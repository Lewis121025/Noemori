//! 改名规划的实时正文快照；并行部分只读盘，所有分片成功后才能生成写入日志。

use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};

use crate::rename::journal::RenameJournal;
use std::io;

use crate::storage::path::resolve_in_root;
use crate::{Error, LinkRecord, Vault};

/// 身份键、链接区间和正文来自同一次读取，不能混用不同版本。
pub(super) struct RenameSnapshot {
    /// 本批可见文件集合；只随已提交事务更新，外部增删由提交前扫描拒绝。
    pub files: Vec<String>,
    /// 标题和别名用于本次规划的歧义判断。
    pub extras: HashMap<String, Vec<String>>,
    /// 原始正文与同版本链接区间用于字节级改写。
    pub documents: HashMap<String, RenameDocument>,
}

/// 单篇的正文与解析事实同版本保存，后续提交前直接复核原始哈希。
pub(super) struct RenameDocument {
    pub bytes: Vec<u8>,
    pub links: Vec<LinkRecord>,
    pub hash: [u8; 32],
}

impl RenameDocument {
    fn new(bytes: Vec<u8>, links: Vec<LinkRecord>) -> Self {
        let hash = Sha256::digest(&bytes).into();
        Self { bytes, links, hash }
    }

    /// 隐藏正文或本批改写后的字节必须重新解析，旧链接区间不能沿用。
    pub fn scan(path: &str, bytes: Vec<u8>) -> (Self, Vec<String>) {
        if crate::vault::is_markdown(path) {
            if let Ok(text) = std::str::from_utf8(&bytes) {
                let scanned = crate::markdown::scan::scan_markdown(path, text);
                let keys = crate::links::identity::keys_from_scan(&scanned);
                return (Self::new(bytes, scanned.links), keys);
            }
        }
        (Self::new(bytes, Vec::new()), Vec::new())
    }
}

impl RenameSnapshot {
    /// 只吸收具有提交标记的日志内容；外部字节始终留给下一次提交前的校验发现。
    pub fn apply_committed(&mut self, journal: &RenameJournal) {
        let mut files: BTreeSet<_> = self.files.iter().cloned().collect();
        for change in &journal.changes {
            if change.path.split('/').any(|part| part.starts_with('.')) {
                continue;
            }
            self.documents.remove(&change.path);
            self.extras.remove(&change.path);
            match &change.after {
                Some(bytes) => {
                    files.insert(change.path.clone());
                    if crate::vault::is_markdown(&change.path) {
                        let (document, keys) = RenameDocument::scan(&change.path, bytes.clone());
                        if !keys.is_empty() {
                            self.extras.insert(change.path.clone(), keys);
                        }
                        self.documents.insert(change.path.clone(), document);
                    }
                }
                None => {
                    files.remove(&change.path);
                }
            }
        }
        self.files = files.into_iter().collect();
    }
}

/// 内容哈希限定的解析事实；只能在读取字节一致时用于生成事务。
struct RenameFacts {
    hash: String,
    keys: Vec<String>,
    links: Vec<LinkRecord>,
}

impl Vault {
    /// 只有扫描器版本与正文哈希均匹配才复用索引事实；时间戳不足以证明区间有效。
    /// 从当前磁盘集合建立批次起点，返回各篇的身份、正文与链接。
    /// # Errors
    /// 任一分片或索引读取失败即返回错误，不能漏掉该分片的身份或入链再继续移动。
    pub(super) fn read_rename_snapshot(&self) -> Result<RenameSnapshot, Error> {
        let files = self.scan_files()?;
        let facts = self.indexed_rename_facts()?;
        let chunks = read_chunks(&files, |paths| self.read_markdown_chunk(paths, &facts))?;
        let mut snapshot = RenameSnapshot {
            files,
            extras: HashMap::new(),
            documents: HashMap::new(),
        };
        for chunk in chunks {
            snapshot.extras.extend(chunk.extras);
            snapshot.documents.extend(chunk.documents);
        }
        Ok(snapshot)
    }

    /// 提交前再次读出全部参与规划的原始字节；不会以时间戳或长度代替正文校验。
    /// `observed` 保存路径及规划时的内容哈希；全部一致才成功。
    /// # Errors
    /// 路径或读取失败、内容发生变化时返回错误。
    pub(super) fn verify_rename_snapshot(
        &self,
        observed: &[(&str, [u8; 32])],
    ) -> Result<(), Error> {
        read_chunks(observed, |files| {
            for (path, expected) in files {
                let hash: [u8; 32] = Sha256::digest(self.read(path)?).into();
                if hash != *expected {
                    return Err(Error::FileChanged {
                        path: resolve_in_root(self.root(), path)?,
                    });
                }
            }
            Ok(())
        })?;
        Ok(())
    }

    fn read_markdown_chunk(
        &self,
        files: &[String],
        facts: &HashMap<String, RenameFacts>,
    ) -> Result<RenameSnapshot, Error> {
        let mut documents = HashMap::new();
        let mut extras = HashMap::new();
        for path in files {
            if !crate::vault::is_markdown(path) {
                continue;
            }
            let read = self.read(path)?;
            let hash = Sha256::digest(&read);
            let cached = facts
                .get(path)
                .filter(|fact| fact.hash == crate::vault::hex_digest(&hash));
            let (keys, links) = if let Some(fact) = cached {
                (fact.keys.clone(), fact.links.clone())
            } else if let Ok(text) = std::str::from_utf8(&read) {
                let scanned = crate::markdown::scan::scan_markdown(path, text);
                (crate::links::identity::keys_from_scan(&scanned), scanned.links)
            } else {
                (Vec::new(), Vec::new())
            };
            if !keys.is_empty() {
                extras.insert(path.clone(), keys);
            }
            documents.insert(path.clone(), RenameDocument { bytes: read, links, hash: hash.into() });
        }
        Ok(RenameSnapshot {
            files: Vec::new(),
            extras,
            documents,
        })
    }

    /// 同一索引版本中的哈希和派生事实必须一起读取，且不能复用旧扫描器的区间。
    fn indexed_rename_facts(&self) -> Result<HashMap<String, RenameFacts>, Error> {
        let conn = self.lock_conn()?;
        if crate::index::scan_version(&conn)? != crate::index::SCAN_VERSION {
            return Ok(HashMap::new());
        }
        let rows = crate::index::load_files(&conn)?;
        let aliases = crate::index::load_alias_keys(&conn)?;
        let mut keys = crate::links::identity::extras_from_files(&rows, &aliases);
        let mut facts: HashMap<_, _> = rows
            .into_iter()
            .map(|row| {
                let fact = RenameFacts {
                    hash: row.content_hash,
                    keys: keys.remove(&row.path).unwrap_or_default(),
                    links: Vec::new(),
                };
                (row.path, fact)
            })
            .collect();
        for link in crate::index::load_links(&conn)? {
            if let Some(fact) = facts.get_mut(&link.from_path) {
                fact.links.push(link);
            }
        }
        Ok(facts)
    }
}

/// 两轮正文读取共用同一并发上限；小库避免线程成本，大库最多占用四个核心。
/// 全部分片退出后才传播失败，保证返回时没有遗留的读取任务。
fn read_chunks<T: Sync, R: Send>(
    files: &[T],
    read: impl Fn(&[T]) -> Result<R, Error> + Sync,
) -> Result<Vec<R>, Error> {
    let workers = std::thread::available_parallelism().map_or(1, |count| count.get().min(4));
    if files.len() < 128 || workers == 1 {
        return Ok(vec![read(files)?]);
    }
    std::thread::scope(|scope| {
        let read = &read;
        let handles: Vec<_> = files
            .chunks(files.len().div_ceil(workers))
            .map(|chunk| scope.spawn(move || read(chunk)))
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| Error::Io(io::Error::other("改名读取线程意外退出")))?
            })
            .collect();
        results.into_iter().collect()
    })
}
