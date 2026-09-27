//! 笔记库：根目录约束下的原始字节读写与链接索引。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::Error;
use crate::index::{self, DerivedRows, FileRow, HeadingRecord};
use crate::link::LinkRecord;
use crate::mention::{self, MentionKind, MentionRecord, Mentions};
use crate::pathutil::{path_to_slashes, resolve_in_root};
use crate::scan;
use crate::search::{SearchHit, SearchQuery};

/// 已打开的笔记库。
///
/// `root` 是已保存笔记的唯一真相；`index_dir` 存放派生索引、草稿与操作恢复记录，应在库外。
pub struct Vault {
    root: PathBuf,
    index_dir: PathBuf,
    conn: Mutex<Connection>,
    /// 最近一次扫描的库内路径。列目录和解析链接走这里，避免每次下盘。
    inventory: Mutex<Option<Inventory>>,
    /// 空目录也参与监视变更判断，文件树不能依赖文件索引推断全部目录。
    directories: Mutex<Vec<String>>,
    /// 文件提交串行化，避免两次应用内保存同时通过版本检查。
    writes: Mutex<()>,
    pub(super) recovery: crate::recovery::RecoveryStore,
}

impl Vault {
    /// 打开目录作为库根并重建链接索引。
    ///
    /// `root` 必须已存在且为目录。`index_dir` 若不存在则创建。
    ///
    /// # Errors
    ///
    /// 根不是目录、状态目录不可用、改名恢复受阻或索引写入失败时返回错误。
    pub fn open(root: impl AsRef<Path>, index_dir: impl AsRef<Path>) -> Result<Self, Error> {
        let root = root.as_ref().to_path_buf();
        let metadata = fs::metadata(&root)?;
        if !metadata.is_dir() {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "库根必须是目录",
            )));
        }
        let index_dir = index_dir.as_ref().to_path_buf();
        fs::create_dir_all(&index_dir)?;
        let _operation = lock_operation(&index_dir)?;
        let recovery = crate::recovery::RecoveryStore::open(&index_dir.join("recovery.sqlite"))?;
        crate::rename::recover_pending(&root, &recovery)?;
        let conn = index::open_connection(&index_dir.join("index.sqlite"))?;
        let vault = Self {
            root,
            index_dir,
            conn: Mutex::new(conn),
            inventory: Mutex::new(None),
            directories: Mutex::new(Vec::new()),
            writes: Mutex::new(()),
            recovery,
        };
        let _ = vault.refresh_index_locked()?;
        Ok(vault)
    }

    /// 按磁盘现状刷新链接索引。
    ///
    /// `mtime` 未变的文件不读内容；内容哈希未变则只更新时间戳。
    /// 扫描器版本落后时忽略上述跳过，全量重扫。
    /// 文件集合变了才重算全库链接指向。
    /// 磁盘集合与每篇 `mtime` 都未变时不写 SQLite，避免打开库和监视空转把整表重抄。
    ///
    /// 文件监视在防抖后调用；外部改盘不会走 `write`，必须显式刷新。
    ///
    /// 返回是否改写了索引；监视器据此决定要不要通知界面。
    ///
    /// # Errors
    ///
    /// 读盘或写索引失败。
    pub fn refresh_index(&self) -> Result<bool, Error> {
        let _guard = self.lock_writes()?;
        self.refresh_index_locked()
    }

    pub(super) fn refresh_index_locked(&self) -> Result<bool, Error> {
        let entries = crate::entries::scan_entries(&self.root, false)?;
        let files: Vec<_> = entries
            .iter()
            .filter(|entry| entry.kind == crate::EntryKind::File)
            .map(|entry| entry.path.clone())
            .collect();
        let directories: Vec<_> = entries
            .into_iter()
            .filter(|entry| entry.kind == crate::EntryKind::Directory)
            .map(|entry| entry.path)
            .collect();
        self.store_indexed_inventory(&files)?;
        let (indexed_files, indexed_links, mut aliases, stale_scan) = {
            let conn = self.lock_conn()?;
            (
                index::load_files(&conn)?,
                index::load_links(&conn)?,
                index::load_alias_keys(&conn)?,
                index::scan_version(&conn)? != index::SCAN_VERSION,
            )
        };
        let by_path: HashMap<String, FileRow> = indexed_files
            .into_iter()
            .map(|row| (row.path.clone(), row))
            .collect();
        let mut links_by: HashMap<String, Vec<LinkRecord>> = HashMap::new();
        for link in indexed_links {
            links_by
                .entry(link.from_path.clone())
                .or_default()
                .push(link);
        }

        let disk_set: HashSet<&str> = files.iter().map(String::as_str).collect();
        let indexed_set: HashSet<&str> = by_path.keys().map(String::as_str).collect();
        let set_changed = disk_set != indexed_set;

        let mut mtimes = Vec::with_capacity(files.len());
        for rel in &files {
            let abs = resolve_in_root(&self.root, rel)?;
            mtimes.push(mtime_stamp(&fs::metadata(&abs)?));
        }

        if !stale_scan && !set_changed {
            let all_match = files
                .iter()
                .zip(&mtimes)
                .all(|(rel, mtime)| by_path.get(rel).is_some_and(|old| old.mtime == *mtime));
            if all_match {
                return self.store_directories(directories);
            }
        }

        // 派生表按篇增量同步：只有已消失的路径需要显式删除。
        let removals: Vec<String> = by_path
            .keys()
            .filter(|path| !disk_set.contains(path.as_str()))
            .cloned()
            .collect();

        let RefreshRows {
            files: file_rows,
            mut links,
            derived,
        } = collect_refresh_rows(&self.root, &files, &mtimes, &by_path, &links_by, stale_scan)?;
        let inventory = identity_inventory(&files, &file_rows, &mut aliases, &removals, &derived);
        // 标题和别名变了也要重绑其它文件的链接，不能只在文件集合变化时重算。
        for link in &mut links {
            assign_target(link, &inventory);
        }

        let conn = self.lock_conn()?;
        index::replace_all(&conn, &file_rows, &links, &removals, &derived)?;
        drop(conn);
        self.store_built_inventory(inventory)?;
        self.store_directories(directories)?;
        Ok(true)
    }

    fn store_directories(&self, directories: Vec<String>) -> Result<bool, Error> {
        let mut previous = self
            .directories
            .lock()
            .map_err(|_| Error::Io(io::Error::other("目录缓存锁已毒化")))?;
        let changed = *previous != directories;
        *previous = directories;
        Ok(changed)
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
        self.conn
            .lock()
            .map_err(|_| Error::Io(io::Error::other("索引锁已毒化")))
    }

    pub(super) fn lock_writes(&self) -> Result<WriteGuard<'_>, Error> {
        let local = self
            .writes
            .lock()
            .map_err(|_| Error::Io(io::Error::other("文件写入锁已毒化")))?;
        Ok(WriteGuard {
            _local: local,
            _operation: lock_operation(&self.index_dir)?,
        })
    }

    fn lock_inventory(&self) -> Result<std::sync::MutexGuard<'_, Option<Inventory>>, Error> {
        self.inventory
            .lock()
            .map_err(|_| Error::Io(io::Error::other("目录缓存锁已毒化")))
    }

    fn store_inventory(&self, files: Vec<String>) -> Result<(), Error> {
        self.store_built_inventory(Inventory::from_files(files))
    }

    /// 用当前索引里的标题和别名重建解析表，供未改文件的快速路径继续按身份解析。
    fn store_indexed_inventory(&self, files: &[String]) -> Result<(), Error> {
        let conn = self.lock_conn()?;
        let rows = index::load_files(&conn)?;
        let aliases = index::load_alias_keys(&conn)?;
        drop(conn);
        let extras = crate::identity::extras_from_files(&rows, &aliases);
        self.store_built_inventory(Inventory::with_extra(files.to_vec(), &extras))
    }

    fn store_built_inventory(&self, inventory: Inventory) -> Result<(), Error> {
        *self.lock_inventory()? = Some(inventory);
        Ok(())
    }

    /// 库根。
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 索引目录。
    #[must_use]
    pub fn index_dir(&self) -> &Path {
        &self.index_dir
    }

    /// 读取相对路径文件的原始字节。
    ///
    /// # Errors
    ///
    /// 路径越界返回 [`Error::PathEscape`]；文件不存在返回 [`Error::NotFound`]。
    pub fn read(&self, rel: &str) -> Result<Vec<u8>, Error> {
        let path = resolve_in_root(&self.root, rel)?;
        match fs::read(&path) {
            Ok(bytes) => Ok(bytes),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Err(Error::NotFound { path }),
            Err(err) => Err(Error::Io(err)),
        }
    }

    /// 列出库内文件及可恢复草稿的相对路径（跳过以 `.` 开头的磁盘条目）。
    ///
    /// 打开或刷新之后走内存名单，避免每次解析链接、加载图片都递归扫盘。
    ///
    /// # Errors
    ///
    /// 读目录失败时返回 IO 错误。
    pub fn list_files(&self) -> Result<Vec<String>, Error> {
        let mut files = self.list_disk_files()?;
        files.extend(self.recovery.paths()?);
        files.sort();
        files.dedup();
        Ok(files)
    }

    pub(super) fn list_disk_files(&self) -> Result<Vec<String>, Error> {
        {
            let guard = self.lock_inventory()?;
            if let Some(inventory) = guard.as_ref() {
                return Ok(inventory.files.clone());
            }
        }
        let files = self.scan_files()?;
        self.store_inventory(files.clone())?;
        Ok(files)
    }

    pub(super) fn scan_files(&self) -> Result<Vec<String>, Error> {
        Ok(crate::entries::scan_entries(&self.root, false)?
            .into_iter()
            .filter(|entry| entry.kind == crate::EntryKind::File)
            .map(|entry| entry.path)
            .collect())
    }

    pub(super) fn directory_paths(&self) -> Result<Vec<String>, Error> {
        Ok(self
            .directories
            .lock()
            .map_err(|_| Error::Io(io::Error::other("目录缓存锁已毒化")))?
            .clone())
    }

    /// 指向 `path` 的入链。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn links_to(&self, path: &str) -> Result<Vec<LinkRecord>, Error> {
        let conn = self.lock_conn()?;
        index::links_to(&conn, path)
    }

    /// 指向 `path` 的已链接提及与未链接提及。
    ///
    /// 未链接在查询时扫其它 Markdown，不写索引。
    ///
    /// # Errors
    ///
    /// 索引查询失败。单个 Markdown 读失败则跳过该文件。
    pub fn mentions_to(&self, path: &str) -> Result<Mentions, Error> {
        let (files, linked_links) = {
            let conn = self.lock_conn()?;
            (index::load_files(&conn)?, index::links_to(&conn, path)?)
        };
        let file_map: HashMap<String, FileRow> = files
            .into_iter()
            .map(|row| (row.path.clone(), row))
            .collect();
        let title = file_map.get(path).map_or("", |row| row.title.as_str());
        let needles = mention::mention_needles(title, path);
        let linked = self.mentions_from_links(&linked_links, &file_map);
        let mut unlinked = Vec::new();
        for rel in self.list_files()? {
            if rel == path || !is_markdown(&rel) {
                continue;
            }
            let Ok(bytes) = self.read(&rel) else {
                continue;
            };
            let Ok(source) = String::from_utf8(bytes) else {
                continue;
            };
            let hits = mention::find_unlinked(&rel, &source, &needles);
            let meta = file_map.get(&rel);
            let from_title =
                meta.map_or_else(|| file_title_fallback(&rel), |row| row.title.clone());
            let mtime = meta.map_or(0, |row| row.mtime);
            for (start, end) in hits {
                let start_byte = i64::try_from(start).unwrap_or(i64::MAX);
                let end_byte = i64::try_from(end).unwrap_or(i64::MAX);
                unlinked.push(MentionRecord {
                    from_path: rel.clone(),
                    from_title: from_title.clone(),
                    mtime,
                    start_byte,
                    end_byte,
                    snippet: mention::paragraph_snippet(&source, start, end),
                    kind: MentionKind::Unlinked,
                    link_kind: None,
                    to_raw: source.get(start..end).unwrap_or("").to_string(),
                });
            }
        }
        Ok(Mentions { linked, unlinked })
    }

    /// 把未链接提及就地转为 wiki 链接。
    ///
    /// `[start_byte, end_byte)` 区间必须仍是 `expected` 文本——区间来自
    /// 查询时的扫描，文件外部变更后宁可拒绝也不能按过期偏移改写。
    /// 替换文本按「唯一解析的最短形态」生成，正文其余字节保持不变；
    /// 提及文本与目标显示名不同时以别名保留原句。
    ///
    /// # Errors
    ///
    /// 目标不在库内、非 Markdown 源、区间无效或与 `expected` 不符
    /// （[`Error::FileChanged`]）、读盘或写盘失败时返回错误。
    pub fn linkify_mention(
        &self,
        from: &str,
        start_byte: i64,
        end_byte: i64,
        expected: &str,
        target: &str,
    ) -> Result<crate::rename::RenameOutcome, Error> {
        if !is_markdown(from) {
            return Err(Error::Io(io::Error::other("只有 Markdown 支持转为链接")));
        }
        let _guard = self.lock_writes()?;
        let inventory = {
            let guard = self.lock_inventory()?;
            guard
                .as_ref()
                .ok_or_else(|| Error::Io(io::Error::other("库尚未完成扫描")))?
                .clone()
        };
        if !inventory.set.contains(target) {
            return Err(Error::NotFound {
                path: self.root().join(target),
            });
        }
        let path = resolve_in_root(self.root(), from)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return Err(Error::NotFound { path });
            }
            Err(err) => return Err(Error::Io(err)),
        };
        let changed = || Error::FileChanged { path: path.clone() };
        let start = usize::try_from(start_byte).map_err(|_| changed())?;
        let end = usize::try_from(end_byte).map_err(|_| changed())?;
        if start > end {
            return Err(changed());
        }
        let current = bytes
            .get(start..end)
            .and_then(|slice| std::str::from_utf8(slice).ok())
            .unwrap_or("");
        if current != expected {
            return Err(changed());
        }
        let replacement = wiki_link_text(expected, target, &inventory);
        let mut out = Vec::with_capacity(bytes.len() - (end - start) + replacement.len());
        out.extend_from_slice(&bytes[..start]);
        out.extend_from_slice(replacement.as_bytes());
        out.extend_from_slice(&bytes[end..]);
        let staged = crate::save::stage(&path, &out)?;
        staged
            .persist(&path)
            .map_err(|err| Error::Io(io::Error::other(err.error.to_string())))?;
        crate::save::sync_parent(&path)?;
        // 写盘已成事实；索引刷新失败降级为警告，与其余入口操作同一口径。
        let warning = match self.reindex_written(from, &out) {
            Ok(()) => None,
            Err(error) => Some(format!("链接已写入，索引刷新失败：{error}")),
        };
        Ok(crate::rename::RenameOutcome { warning })
    }

    fn mentions_from_links(
        &self,
        links: &[LinkRecord],
        files: &HashMap<String, FileRow>,
    ) -> Vec<MentionRecord> {
        let mut sources: HashMap<String, Option<String>> = HashMap::new();
        let mut out = Vec::with_capacity(links.len());
        for link in links {
            if !sources.contains_key(&link.from_path) {
                let text = match self.read(&link.from_path) {
                    Ok(bytes) => String::from_utf8(bytes).ok(),
                    Err(_) => None,
                };
                sources.insert(link.from_path.clone(), text);
            }
            let Some(Some(source)) = sources.get(&link.from_path) else {
                continue;
            };
            let meta = files.get(&link.from_path);
            let from_title = meta.map_or_else(
                || file_title_fallback(&link.from_path),
                |row| row.title.clone(),
            );
            let mtime = meta.map_or(0, |row| row.mtime);
            let start = usize::try_from(link.start_byte).unwrap_or(0);
            let end = usize::try_from(link.end_byte).unwrap_or(0);
            out.push(MentionRecord {
                from_path: link.from_path.clone(),
                from_title,
                mtime,
                start_byte: link.start_byte,
                end_byte: link.end_byte,
                snippet: mention::paragraph_snippet(source, start, end),
                kind: MentionKind::Linked,
                link_kind: Some(link.kind),
                to_raw: link.to_raw.clone(),
            });
        }
        out
    }

    /// `path` 的出链。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn links_from(&self, path: &str) -> Result<Vec<LinkRecord>, Error> {
        let conn = self.lock_conn()?;
        index::links_from(&conn, path)
    }

    /// 把 `from` 文件中的链接原文解析为跳转目标：路径、锚点与歧义候选。
    ///
    /// wiki 按键精确匹配（完整路径、去 `.md` 路径、文件名、词干、文首标题、
    /// frontmatter 别名），唯一才命中；多义时返回候选列表。
    /// Markdown 相对路径按源文件目录拼接。
    /// 纯锚点链接（`[[#标题]]`、`[](#标题)`）指向源文件自身。
    #[must_use]
    pub fn resolve_link(
        &self,
        from: &str,
        raw: &str,
        kind: crate::link::LinkKind,
    ) -> crate::link::LinkTarget {
        use crate::link::LinkTarget;
        let Ok(guard) = self.lock_inventory() else {
            return LinkTarget::Dead;
        };
        let Some(inventory) = guard.as_ref() else {
            return LinkTarget::Dead;
        };
        let (path, suffix) = crate::link::split_resource(raw.trim());
        let anchor = crate::link::anchor_of(suffix, kind);
        if path.is_empty() {
            return match anchor {
                Some(anchor) => LinkTarget::Resolved {
                    path: from.to_string(),
                    anchor: Some(anchor),
                },
                None => LinkTarget::Dead,
            };
        }
        match kind {
            crate::link::LinkKind::Wiki => match resolve_wiki(inventory, path) {
                WikiHits::One(path) => LinkTarget::Resolved { path, anchor },
                WikiHits::Many(candidates) => LinkTarget::Ambiguous { candidates, anchor },
                WikiHits::None => LinkTarget::Dead,
            },
            crate::link::LinkKind::Markdown => match resolve_markdown(inventory, from, path) {
                Some(path) => LinkTarget::Resolved { path, anchor },
                None => LinkTarget::Dead,
            },
        }
    }

    /// 一篇文件的全部标题，按文档顺序；供锚点解析与标题补全。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn headings(&self, path: &str) -> Result<Vec<HeadingRecord>, Error> {
        let conn = self.lock_conn()?;
        index::load_headings(&conn, path)
    }

    /// 全库标签及计数，标签升序；供标签浏览面板。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn tag_counts(&self) -> Result<Vec<crate::index::TagCount>, Error> {
        let conn = self.lock_conn()?;
        index::load_tag_counts(&conn)
    }

    /// 全部 Markdown 笔记的标题与别名，路径升序；供快速切换器与别名补全。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn note_keys(&self) -> Result<Vec<crate::identity::NoteKeys>, Error> {
        let conn = self.lock_conn()?;
        let files = index::load_files(&conn)?;
        let aliases = index::load_alias_keys(&conn)?;
        Ok(crate::identity::note_keys(&files, &aliases))
    }

    /// 全库关系图谱；`include_dead` 为真时死链目标作为虚节点出现。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn graph(&self, include_dead: bool) -> Result<crate::Graph, Error> {
        let conn = self.lock_conn()?;
        crate::graph::load_graph(&conn, include_dead)
    }

    /// 结构化全文搜索；条件语义见 [`SearchQuery`]。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn search(&self, query: &SearchQuery) -> Result<Vec<SearchHit>, Error> {
        let conn = self.lock_conn()?;
        crate::search::execute(&conn, query)
    }

    /// 用刚写入的字节更新该文件索引。
    ///
    /// 必须扫盘：外部删文件不会走 `write`，缓存里还留着旧路径。
    /// 标题或别名变了要重绑全库链接；只改正文时只更新这一篇的出链。
    pub(super) fn reindex_written(&self, rel: &str, bytes: &[u8]) -> Result<(), Error> {
        let old_wiki = self
            .lock_inventory()?
            .as_ref()
            .map(|inventory| inventory.wiki.clone());
        let files = self.scan_files()?;
        let mtime = mtime_stamp(&fs::metadata(&resolve_in_root(&self.root, rel)?)?);
        let (row, mut new_links, derived) = index_bytes(rel, bytes, mtime);
        let (mut aliases, mut rows) = {
            let conn = self.lock_conn()?;
            (index::load_alias_keys(&conn)?, index::load_files(&conn)?)
        };
        let indexed_set: HashSet<String> = rows.iter().map(|item| item.path.clone()).collect();
        aliases.insert(
            rel.to_string(),
            crate::identity::alias_keys(&derived.attributes),
        );
        if let Some(existing) = rows.iter_mut().find(|item| item.path == rel) {
            existing.title.clone_from(&row.title);
            existing.kind.clone_from(&row.kind);
        } else {
            rows.push(row.clone());
        }
        rows.retain(|item| files.iter().any(|path| path == &item.path));
        let extras = crate::identity::extras_from_files(&rows, &aliases);
        let inventory = Inventory::with_extra(files, &extras);
        for link in &mut new_links {
            assign_target(link, &inventory);
        }

        let conn = self.lock_conn()?;
        let set_changed = inventory.set != indexed_set;
        if set_changed {
            for old in &indexed_set {
                if !inventory.set.contains(old) {
                    index::delete_file(&conn, old)?;
                }
            }
        }
        index::upsert_file(&conn, &row, &new_links, &derived)?;
        // 身份键变化会改写其它文件里的标题/别名链接，不能只更新刚写入的这篇。
        if old_wiki.as_ref() != Some(&inventory.wiki) {
            let mut links = index::load_links(&conn)?;
            for link in &mut links {
                assign_target(link, &inventory);
            }
            index::replace_links(&conn, &links)?;
        }
        drop(conn);
        self.store_built_inventory(inventory)?;
        Ok(())
    }
}

// 文件句柄释放时自动解锁；多个内核实例不能把进行中的改名当作崩溃日志恢复。
pub(super) struct WriteGuard<'a> {
    _local: std::sync::MutexGuard<'a, ()>,
    _operation: fs::File,
}

fn lock_operation(index_dir: &Path) -> Result<fs::File, Error> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(index_dir.join("operations.lock"))?;
    file.lock()?;
    Ok(file)
}

/// 库内路径名单与 wiki 名到路径的映射。
#[derive(Clone)]
pub(super) struct Inventory {
    files: Vec<String>,
    set: HashSet<String>,
    wiki: HashMap<String, Vec<String>>,
}

impl Inventory {
    pub(super) fn from_files(files: Vec<String>) -> Self {
        Self::with_extra(files, &HashMap::new())
    }

    /// `extra` 是每篇笔记的标题与别名；与路径键重复的项在并入时丢掉。
    pub(super) fn with_extra(files: Vec<String>, extra: &HashMap<String, Vec<String>>) -> Self {
        let wiki = wiki_map(&files, extra);
        let set = files.iter().cloned().collect();
        Self { files, set, wiki }
    }
}

fn wiki_map(
    files: &[String],
    extra: &HashMap<String, Vec<String>>,
) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for file in files {
        let path = Path::new(file);
        // 每个文件的键去重后各推一次：根级文件的完整路径与文件名重合，
        // 重复推送会把唯一命中伪造成歧义。
        let mut keys: Vec<String> = vec![file.clone()];
        if is_markdown(file) {
            if let Some(stem) = path.file_stem() {
                if let Ok(stem_path) = path_to_slashes(&path.with_file_name(stem)) {
                    if !keys.contains(&stem_path) {
                        keys.push(stem_path);
                    }
                }
            }
        }
        if let Some(name) = path
            .file_name()
            .map(|part| part.to_string_lossy().into_owned())
        {
            if !keys.contains(&name) {
                keys.push(name.clone());
            }
            if let Some(stem) = path
                .file_stem()
                .map(|part| part.to_string_lossy().into_owned())
            {
                if stem != name && !keys.contains(&stem) {
                    keys.push(stem);
                }
            }
        }
        if let Some(extra_keys) = extra.get(file) {
            for key in extra_keys {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
            }
        }
        for key in keys {
            map.entry(key).or_default().push(file.clone());
        }
    }
    map
}

/// 从字节抽出文件行、出链和派生数据。
///
/// 出链先保持未解析。标题和别名要等整库身份表齐了才能绑定，调用方负责 `assign_target`。
fn index_bytes(rel: &str, bytes: &[u8], mtime: i64) -> (FileRow, Vec<LinkRecord>, DerivedRows) {
    if !is_markdown(rel) {
        return (
            FileRow {
                path: rel.to_string(),
                title: file_title_fallback(rel),
                kind: "other".to_string(),
                mtime,
                content_hash: hex_sha256(bytes),
            },
            Vec::new(),
            empty_derived(),
        );
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        // 不可解码的 Markdown：无链接、无派生数据，标题按文件名回退。
        return (
            FileRow {
                path: rel.to_string(),
                title: file_title_fallback(rel),
                kind: "markdown".to_string(),
                mtime,
                content_hash: hex_sha256(bytes),
            },
            Vec::new(),
            empty_derived(),
        );
    };
    let scanned = scan::scan_markdown(rel, text);
    let links = scanned.links;
    let title = scanned.title.unwrap_or_else(|| file_title_fallback(rel));
    let row = FileRow {
        path: rel.to_string(),
        title: title.clone(),
        kind: "markdown".to_string(),
        mtime,
        content_hash: hex_sha256(bytes),
    };
    let derived = DerivedRows {
        headings: scanned
            .headings
            .into_iter()
            .map(|heading| HeadingRecord {
                path: rel.to_string(),
                level: heading.level,
                text: heading.text,
                start_byte: heading.start_byte,
                end_byte: heading.end_byte,
            })
            .collect(),
        tags: scanned.tags,
        attributes: scanned.attributes,
        text: Some((title, scanned.body_text)),
    };
    (row, links, derived)
}

/// 无派生数据的空行集合。
fn empty_derived() -> DerivedRows {
    DerivedRows {
        headings: Vec::new(),
        tags: Vec::new(),
        attributes: Vec::new(),
        text: None,
    }
}

fn mtime_stamp(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            i64::try_from(duration.as_nanos()).unwrap_or(i64::MAX)
        })
}

pub(super) fn is_markdown(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn file_title_fallback(rel: &str) -> String {
    Path::new(rel)
        .file_stem()
        .map_or_else(|| rel.to_string(), |s| s.to_string_lossy().into_owned())
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().fold(String::new(), |mut acc, b| {
        use std::fmt::Write as _;
        let _ = write!(acc, "{b:02x}");
        acc
    })
}

/// 一次刷新收集到的文件行、出链和需要重写的派生数据。
struct RefreshRows {
    files: Vec<FileRow>,
    links: Vec<LinkRecord>,
    derived: Vec<(String, crate::index::DerivedRows)>,
}

/// 未改文件沿用索引行；内容变了才重读并抽出派生数据。
fn collect_refresh_rows(
    root: &Path,
    files: &[String],
    mtimes: &[i64],
    by_path: &HashMap<String, FileRow>,
    links_by: &HashMap<String, Vec<LinkRecord>>,
    stale_scan: bool,
) -> Result<RefreshRows, Error> {
    let mut file_rows = Vec::new();
    let mut links = Vec::new();
    let mut derived = Vec::new();
    for (rel, mtime) in files.iter().zip(mtimes) {
        if !stale_scan {
            if let Some(old) = by_path.get(rel) {
                if old.mtime == *mtime {
                    file_rows.push(old.clone());
                    if let Some(existing) = links_by.get(rel) {
                        links.extend(existing.iter().cloned());
                    }
                    continue;
                }
            }
        }
        let bytes = fs::read(resolve_in_root(root, rel)?)?;
        let hash = hex_sha256(&bytes);
        if !stale_scan {
            if let Some(old) = by_path.get(rel) {
                if old.content_hash == hash {
                    let mut updated = old.clone();
                    updated.mtime = *mtime;
                    file_rows.push(updated);
                    if let Some(existing) = links_by.get(rel) {
                        links.extend(existing.iter().cloned());
                    }
                    continue;
                }
            }
        }
        let (row, outgoing, rows) = index_bytes(rel, &bytes, *mtime);
        file_rows.push(row);
        links.extend(outgoing);
        derived.push((rel.clone(), rows));
    }
    Ok(RefreshRows {
        files: file_rows,
        links,
        derived,
    })
}

/// 用本次扫描覆盖别名后，按标题和别名建成解析表。
fn identity_inventory(
    files: &[String],
    file_rows: &[crate::index::FileRow],
    aliases: &mut std::collections::HashMap<String, Vec<String>>,
    removals: &[String],
    derived: &[(String, crate::index::DerivedRows)],
) -> Inventory {
    for path in removals {
        aliases.remove(path);
    }
    for (path, rows) in derived {
        aliases.insert(path.clone(), crate::identity::alias_keys(&rows.attributes));
    }
    let extras = crate::identity::extras_from_files(file_rows, aliases);
    Inventory::with_extra(files.to_vec(), &extras)
}

/// 把一条索引链接写成唯一路径或未解析状态。
///
/// 纯锚点记为 [`crate::link::LinkResolution::SelfAnchor`]，不产生图边。
pub(super) fn assign_target(link: &mut crate::link::LinkRecord, inventory: &Inventory) {
    let (to_path, resolution) = indexed_target(inventory, &link.from_path, &link.to_raw, link.kind);
    link.to_path = to_path;
    link.resolution = resolution;
}

fn indexed_target(
    inventory: &Inventory,
    from: &str,
    raw: &str,
    kind: crate::link::LinkKind,
) -> (Option<String>, crate::link::LinkResolution) {
    use crate::link::LinkResolution;
    let (path, suffix) = crate::link::split_resource(raw.trim());
    if path.is_empty() {
        let anchor = crate::link::anchor_of(suffix, kind);
        return (
            None,
            if anchor.is_some() {
                LinkResolution::SelfAnchor
            } else {
                LinkResolution::Dead
            },
        );
    }
    match kind {
        crate::link::LinkKind::Wiki => match resolve_wiki(inventory, path) {
            WikiHits::One(hit) => (Some(hit), LinkResolution::Resolved),
            WikiHits::Many(_) => (None, LinkResolution::Ambiguous),
            WikiHits::None => (None, LinkResolution::Dead),
        },
        crate::link::LinkKind::Markdown => match resolve_markdown(inventory, from, path) {
            Some(hit) => (Some(hit), LinkResolution::Resolved),
            None => (None, LinkResolution::Dead),
        },
    }
}

pub(super) fn resolve_against(
    inventory: &Inventory,
    from: &str,
    raw: &str,
    kind: crate::link::LinkKind,
) -> Option<String> {
    let (path, _) = crate::link::split_resource(raw.trim());
    // 纯锚点链接指向源文件自身，不构成图边，索引里保持死链语义。
    if path.is_empty() {
        return None;
    }
    match kind {
        crate::link::LinkKind::Wiki => match resolve_wiki(inventory, path) {
            WikiHits::One(hit) => Some(hit),
            WikiHits::None | WikiHits::Many(_) => None,
        },
        crate::link::LinkKind::Markdown => resolve_markdown(inventory, from, path),
    }
}

/// wiki 目标的解析候选。
enum WikiHits {
    /// 无任何键命中。
    None,
    /// 唯一命中。
    One(String),
    /// 名称歧义；候选按路径升序。
    Many(Vec<String>),
}

/// 解析 wiki 目标：按键精确匹配（键集合 = 完整路径、去 `.md` 路径、
/// 文件名、词干），多义时返回全部候选而不是静默取一。
///
/// 不做「补 `.md` 再试」的回落：裸名同时命中 `C.md` 与 `C.txt` 的词干时
/// 就是真歧义，回落会把歧义伪装成唯一命中。
fn resolve_wiki(inventory: &Inventory, raw: &str) -> WikiHits {
    match inventory.wiki.get(raw).map(Vec::as_slice) {
        Some([hit]) => WikiHits::One(hit.clone()),
        Some(hits) => {
            let mut candidates = hits.to_vec();
            candidates.sort();
            WikiHits::Many(candidates)
        }
        None => WikiHits::None,
    }
}

/// 唯一解析到 `target` 的最短 wiki 目标形态。
///
/// Markdown 目标先试裸词干，再试去 `.md` 的路径，最后全路径；
/// 非 Markdown 目标先试文件名，再全路径。都歧义时保持全路径，
/// 宁可长也不制造新的歧义链接。
fn wiki_target_form(inventory: &Inventory, target: &str) -> String {
    let path = Path::new(target);
    let full = target.to_string();
    let mut candidates: Vec<String> = Vec::new();
    if is_markdown(target) {
        if let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) {
            if let Ok(stem_path) = path_to_slashes(&path.with_file_name(&stem)) {
                candidates.push(stem);
                candidates.push(stem_path);
            }
        }
    } else if let Some(name) = path
        .file_name()
        .map(|part| part.to_string_lossy().into_owned())
    {
        candidates.push(name);
    }
    candidates.push(full.clone());
    candidates
        .into_iter()
        .find(|form| matches!(resolve_wiki(inventory, form), WikiHits::One(hit) if hit == full))
        .unwrap_or(full)
}

/// 提及替换成的链接文本：提及与目标显示名一致时 `[[目标]]`，
/// 否则 `[[目标|提及原文]]` 保留原句；括号与和号由实体编码保护，
/// 别名里的 `|` 按「首个分隔符」解析规则仍属于别名。
fn wiki_link_text(mention_text: &str, target: &str, inventory: &Inventory) -> String {
    let form = wiki_target_form(inventory, target);
    let encoded = crate::wiki::encode_text(&form);
    let path = Path::new(target);
    let display = if is_markdown(target) {
        path.file_stem()
    } else {
        path.file_name()
    }
    .map_or_else(
        || target.to_string(),
        |part| part.to_string_lossy().into_owned(),
    );
    if mention_text == display {
        format!("[[{encoded}]]")
    } else {
        format!("[[{encoded}|{}]]", crate::wiki::encode_text(mention_text))
    }
}

fn resolve_markdown(inventory: &Inventory, from: &str, raw: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    let raw = decoded.as_ref();
    let base = Path::new(from).parent().unwrap_or_else(|| Path::new(""));
    let joined = base.join(raw);
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let rel = path_to_slashes(&out).ok()?;
    inventory.set.contains(&rel).then_some(rel)
}
