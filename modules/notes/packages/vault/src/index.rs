//! `SQLite` 派生索引：链接图、标题、标签、属性与全文。
//!
//! 所有表都是磁盘 Markdown 的派生物，可随时全量重建；`user_version`
//! 记录扫描器版本，落后即重扫。

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};

use crate::error::Error;
use crate::link::{LinkKind, LinkRecord, LinkResolution};

/// 索引里的一行文件记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileRow {
    /// 库内相对路径。
    pub path: String,
    /// 展示标题。
    pub title: String,
    /// `markdown` 或 `other`。
    pub kind: String,
    /// 内容修改时间（自纪元起的纳秒）。
    pub mtime: i64,
    /// 内容 SHA-256 十六进制。
    pub content_hash: String,
}

/// 索引里的一行标题记录。
///
/// `start_byte`/`end_byte` 是标题节点在源文件的 UTF-8 字节区间，
/// 供锚点跳转映射编辑器位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadingRecord {
    /// 源文件库内相对路径。
    pub path: String,
    /// 标题等级（1–6）。
    pub level: i64,
    /// 去除行内语法后的标题纯文本。
    pub text: String,
    /// 区间起点（含）。
    pub start_byte: i64,
    /// 区间终点（不含）。
    pub end_byte: i64,
}

/// 一篇文件的派生索引行（标题/标签/属性/全文）。
///
/// 只随该文件重扫而重建；未改文件的派生行在刷新时保持不动。
pub(crate) struct DerivedRows {
    /// 标题行，按文档顺序。
    pub headings: Vec<HeadingRecord>,
    /// 规范化标签（小写、无 `#`）。
    pub tags: Vec<String>,
    /// frontmatter 属性行 `(key, value)`。
    pub attributes: Vec<(String, String)>,
    /// 全文行 `(title, body)`；非 Markdown 为 `None`，正文不可解码时仅索引文件名标题。
    pub text: Option<(String, String)>,
    /// 与正文同版本的位置映射；写入时与全文行共同提交。
    pub source_map: crate::search_text::SourceMap,
}

/// 打开或创建索引库并建表。
///
/// # Errors
///
/// `SQLite` 失败时返回 IO 包装错误。
pub fn open_connection(path: &std::path::Path) -> Result<Connection, Error> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    register_search_functions(&conn)?;
    // 长词倒排移入版本化排名目录；旧 FTS 正文副本不再参与读取或写入。
    let old_search: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'search_index')",
        [],
        |row| row.get(0),
    )?;
    if old_search {
        conn.execute_batch("DROP TABLE search_index; PRAGMA user_version = 0;")?;
    }
    initialize_tables(conn)
}

/// 搜索使用独立只读连接，不能执行迁移或占用保存连接；打开或注册函数失败时传播错误。
pub(crate) fn open_search_reader(path: &std::path::Path) -> Result<Connection, Error> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    register_search_functions(&conn)?;
    Ok(conn)
}

fn register_search_functions(conn: &Connection) -> Result<(), Error> {
    conn.create_scalar_function(
        "nous_fold",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            Ok(context
                .get::<Option<String>>(0)?
                .map(|text| crate::search_text::fold(&text)))
        },
    )?;
    Ok(())
}

fn initialize_tables(conn: Connection) -> Result<Connection, Error> {
    let tables: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table'
          AND name IN ('files', 'links', 'headings', 'tags', 'attributes', 'search_sources', 'search_short', 'search_pending', 'search_state')",
        [],
        |row| row.get(0),
    )?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            kind TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            content_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY,
            from_path TEXT NOT NULL,
            to_raw TEXT NOT NULL,
            to_path TEXT,
            kind TEXT NOT NULL,
            start_byte INTEGER NOT NULL,
            end_byte INTEGER NOT NULL,
            resolution TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS links_from_path ON links(from_path);
        CREATE INDEX IF NOT EXISTS links_to_path ON links(to_path);
        CREATE TABLE IF NOT EXISTS headings (
            path TEXT NOT NULL,
            idx INTEGER NOT NULL,
            level INTEGER NOT NULL,
            text TEXT NOT NULL,
            start_byte INTEGER NOT NULL,
            end_byte INTEGER NOT NULL,
            PRIMARY KEY (path, idx)
        );
        CREATE TABLE IF NOT EXISTS tags (
            path TEXT NOT NULL,
            tag TEXT NOT NULL,
            PRIMARY KEY (path, tag)
        );
        CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
        CREATE TABLE IF NOT EXISTS attributes (
            path TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS attributes_path ON attributes(path);
        ",
    )?;
    ensure_search_tables(&conn)?;
    if tables != 9 {
        // 派生表被移除后，新建空表必须同时失效旧扫描版本；恢复库始终独立保留。
        conn.pragma_update(None, "user_version", 0)?;
        // 缺失来源表时旧 rowid 不再可信；短词索引随本次全量重扫重建。
        conn.execute("DELETE FROM search_short", [])?;
        conn.execute("UPDATE search_state SET epoch = lower(hex(randomblob(16))), revision = 0 WHERE id = 1", [])?;
    }
    ensure_link_resolution(&conn)?;
    Ok(conn)
}

/// 来源、短词倒排与同步记录共同建表；触发器保证每次来源变更都会推进排名版本。
fn ensure_search_tables(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS search_sources (
            path TEXT PRIMARY KEY,
            body TEXT NOT NULL,
            source_map TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS search_short USING fts5(
            terms, content = '', contentless_delete = 1, detail = none, tokenize = 'ascii'
        );
        CREATE TABLE IF NOT EXISTS search_pending (path TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS search_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            epoch TEXT NOT NULL,
            revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO search_state VALUES (1, lower(hex(randomblob(16))), 0);
        CREATE TRIGGER IF NOT EXISTS search_source_insert AFTER INSERT ON search_sources BEGIN
            INSERT OR IGNORE INTO search_pending VALUES (new.path);
            UPDATE search_state SET revision = revision + 1 WHERE id = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS search_source_delete AFTER DELETE ON search_sources BEGIN
            INSERT OR IGNORE INTO search_pending VALUES (old.path);
            UPDATE search_state SET revision = revision + 1 WHERE id = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS search_source_update AFTER UPDATE ON search_sources BEGIN
            INSERT OR IGNORE INTO search_pending VALUES (old.path), (new.path);
            UPDATE search_state SET revision = revision + 1 WHERE id = 1;
        END;
        ",
    )?;
    Ok(())
}

/// 旧库的 `links` 没有解析状态列；补上默认值后由扫描版本触发全量重绑。
fn ensure_link_resolution(conn: &Connection) -> Result<(), Error> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('links') WHERE name = 'resolution')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        conn.execute(
            "ALTER TABLE links ADD COLUMN resolution TEXT NOT NULL DEFAULT 'dead'",
            [],
        )?;
    }
    Ok(())
}

/// 扫描器/解析输出格式。区间或目标解析变了必须加一，已打开的库才会重扫而不是复用旧行。
pub(crate) const SCAN_VERSION: i32 = 13;

/// 当前索引里记录的扫描器版本；从未写过则为 0。
pub(crate) fn scan_version(conn: &Connection) -> Result<i32, Error> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

/// 读出当前全部文件行。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_files(conn: &Connection) -> Result<Vec<FileRow>, Error> {
    let mut stmt = conn.prepare("SELECT path, title, kind, mtime, content_hash FROM files")?;
    let rows = stmt.query_map([], |row| {
        Ok(FileRow {
            path: row.get(0)?,
            title: row.get(1)?,
            kind: row.get(2)?,
            mtime: row.get(3)?,
            content_hash: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 读出当前全部链接。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_links(conn: &Connection) -> Result<Vec<LinkRecord>, Error> {
    query_links(conn, &format!("SELECT {LINK_COLUMNS} FROM links"), None)
}

/// 读出每篇笔记的别名键；`alias` / `aliases` 之外的属性不参与链接解析。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_alias_keys(conn: &Connection) -> Result<HashMap<String, Vec<String>>, Error> {
    let mut stmt = conn.prepare(
        "SELECT path, key, value FROM attributes WHERE key = 'alias' OR key = 'aliases'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut grouped: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for row in rows {
        let (path, key, value) = row?;
        grouped.entry(path).or_default().push((key, value));
    }
    let mut out = HashMap::new();
    for (path, attributes) in grouped {
        let keys = crate::identity::alias_keys(&attributes);
        if !keys.is_empty() {
            out.insert(path, keys);
        }
    }
    Ok(out)
}

/// 用当前文件集合替换 `files`/`links`，并增量同步派生表。
///
/// `files`/`links` 行小且刷新时已全量在手，维持整表重写；标题/标签/属性/全文
/// 按篇重建：`removals` 删除已消失路径的行，`derived` 只覆盖本次重扫过的文件，
/// 未改文件的派生行保持不动。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn replace_all(
    conn: &Connection,
    files: &[FileRow],
    links: &[LinkRecord],
    removals: &[String],
    derived: &[(String, DerivedRows)],
) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM links; DELETE FROM files;")?;
    {
        let mut insert_file = tx.prepare(
            "INSERT INTO files(path, title, kind, mtime, content_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for file in files {
            insert_file.execute(params![
                file.path,
                file.title,
                file.kind,
                file.mtime,
                file.content_hash
            ])?;
        }
    }
    insert_link_rows(&tx, links)?;
    let changed: Vec<&str> = removals
        .iter()
        .chain(derived.iter().map(|(path, _)| path))
        .map(String::as_str)
        .collect();
    delete_derived(&tx, &changed)?;
    for (path, rows) in derived {
        insert_derived(&tx, path, rows)?;
    }
    tx.commit()?;
    conn.pragma_update(None, "user_version", SCAN_VERSION)?;
    Ok(())
}

/// 写入一篇文件的派生行；调用方须在同一事务中先清理本批次全部旧行。
fn insert_derived(
    tx: &rusqlite::Transaction<'_>,
    path: &str,
    rows: &DerivedRows,
) -> Result<(), Error> {
    {
        let mut insert = tx.prepare(
            "INSERT INTO headings(path, idx, level, text, start_byte, end_byte)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (idx, heading) in rows.headings.iter().enumerate() {
            let idx =
                i64::try_from(idx).map_err(|_| Error::Io(std::io::Error::other("标题序号溢出")))?;
            insert.execute(params![
                path,
                idx,
                heading.level,
                heading.text,
                heading.start_byte,
                heading.end_byte
            ])?;
        }
    }
    {
        let mut insert = tx.prepare("INSERT OR IGNORE INTO tags(path, tag) VALUES (?1, ?2)")?;
        for tag in &rows.tags {
            insert.execute(params![path, tag])?;
        }
    }
    {
        let mut insert =
            tx.prepare("INSERT INTO attributes(path, key, value) VALUES (?1, ?2, ?3)")?;
        for (key, value) in &rows.attributes {
            insert.execute(params![path, key, value])?;
        }
    }
    if let Some((title, body)) = &rows.text {
        let source_map = serde_json::to_string(&rows.source_map).map_err(std::io::Error::other)?;
        tx.execute(
            "INSERT INTO search_sources(path, body, source_map) VALUES (?1, ?2, ?3)",
            params![path, body, source_map],
        )?;
        tx.execute(
            "INSERT INTO search_short(rowid, terms) SELECT rowid, ?2 FROM search_sources WHERE path = ?1",
            params![path, crate::search_text::short_terms(title, body)],
        )?;
    }
    Ok(())
}

/// 只清理本批次路径；来源删除触发待同步记录，避免为单篇更新扫描整个全文库。
fn delete_derived(conn: &Connection, paths: &[&str]) -> Result<(), Error> {
    if paths.is_empty() {
        return Ok(());
    }
    let paths: HashSet<&str> = paths.iter().copied().collect();
    {
        let mut delete = conn.prepare("DELETE FROM search_short WHERE rowid IN (SELECT rowid FROM search_sources WHERE path = ?1)")?;
        for path in &paths {
            delete.execute(params![path])?;
        }
    }
    for table in ["headings", "tags", "attributes", "search_sources"] {
        let mut delete = conn.prepare(&format!("DELETE FROM {table} WHERE path = ?1"))?;
        for path in &paths {
            delete.execute(params![path])?;
        }
    }
    Ok(())
}

/// 全库标签计数的一行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagCount {
    /// 规范化标签（小写、无 `#`）。
    pub tag: String,
    /// 携带该标签的文件数。
    pub count: i64,
}

/// 按标签聚合计数，标签升序；供标签浏览面板组树。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_tag_counts(conn: &Connection) -> Result<Vec<TagCount>, Error> {
    let mut stmt = conn.prepare("SELECT tag, count(*) FROM tags GROUP BY tag ORDER BY tag")?;
    let rows = stmt.query_map([], |row| {
        Ok(TagCount {
            tag: row.get(0)?,
            count: row.get(1)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 读取一篇文件的全部标题，按文档顺序。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_headings(conn: &Connection, path: &str) -> Result<Vec<HeadingRecord>, Error> {
    let mut stmt = conn.prepare(
        "SELECT path, level, text, start_byte, end_byte FROM headings
         WHERE path = ?1 ORDER BY idx",
    )?;
    let rows = stmt.query_map(params![path], |row| {
        Ok(HeadingRecord {
            path: row.get(0)?,
            level: row.get(1)?,
            text: row.get(2)?,
            start_byte: row.get(3)?,
            end_byte: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 只更新一篇文件及其出链与派生行，其它行的 `rowid` 保持不变。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn upsert_file(
    conn: &Connection,
    file: &FileRow,
    outgoing: &[LinkRecord],
    derived: &DerivedRows,
) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM links WHERE from_path = ?1", params![file.path])?;
    tx.execute(
        "INSERT INTO files(path, title, kind, mtime, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            kind = excluded.kind,
            mtime = excluded.mtime,
            content_hash = excluded.content_hash",
        params![
            file.path,
            file.title,
            file.kind,
            file.mtime,
            file.content_hash
        ],
    )?;
    insert_link_rows(&tx, outgoing)?;
    delete_derived(&tx, &[&file.path])?;
    insert_derived(&tx, &file.path, derived)?;
    tx.commit()?;
    Ok(())
}

/// 删除一篇文件及其出链与派生行。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn delete_file(conn: &Connection, path: &str) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM links WHERE from_path = ?1", params![path])?;
    tx.execute("DELETE FROM files WHERE path = ?1", params![path])?;
    delete_derived(&tx, &[path])?;
    tx.commit()?;
    Ok(())
}

/// 用当前链接集合替换 `links` 表，不动 `files`。
///
/// 文件集合变了、需要重绑 `to_path` 时用这个，避免把未改动的文件行删掉重建。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn replace_links(conn: &Connection, links: &[LinkRecord]) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM links;")?;
    insert_link_rows(&tx, links)?;
    tx.commit()?;
    Ok(())
}

fn insert_link_rows(tx: &rusqlite::Transaction<'_>, links: &[LinkRecord]) -> Result<(), Error> {
    let mut insert_link = tx.prepare(
        "INSERT INTO links(from_path, to_raw, to_path, kind, start_byte, end_byte, resolution)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for link in links {
        insert_link.execute(params![
            link.from_path,
            link.to_raw,
            link.to_path,
            link.kind.as_str(),
            link.start_byte,
            link.end_byte,
            link.resolution.as_str()
        ])?;
    }
    Ok(())
}

/// 查询指向 `path` 的入链。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub fn links_to(conn: &Connection, path: &str) -> Result<Vec<LinkRecord>, Error> {
    query_links(
        conn,
        &format!("SELECT {LINK_COLUMNS} FROM links WHERE to_path = ?1"),
        Some(path),
    )
}

/// 查询 `path` 的出链。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub fn links_from(conn: &Connection, path: &str) -> Result<Vec<LinkRecord>, Error> {
    query_links(
        conn,
        &format!("SELECT {LINK_COLUMNS} FROM links WHERE from_path = ?1"),
        Some(path),
    )
}

fn query_links(conn: &Connection, sql: &str, path: Option<&str>) -> Result<Vec<LinkRecord>, Error> {
    let mut stmt = conn.prepare(sql)?;
    let mut out = Vec::new();
    if let Some(path) = path {
        for row in stmt.query_map(params![path], map_link_row)? {
            out.push(row?);
        }
    } else {
        for row in stmt.query_map([], map_link_row)? {
            out.push(row?);
        }
    }
    Ok(out)
}

fn map_link_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LinkRecord> {
    let kind_raw: String = row.get(3)?;
    let kind = kind_raw.parse::<LinkKind>().map_err(|()| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "未知链接种类",
            )),
        )
    })?;
    let resolution_raw: String = row.get(6)?;
    let resolution = resolution_raw.parse::<LinkResolution>().map_err(|()| {
        rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "未知链接解析状态",
            )),
        )
    })?;
    Ok(LinkRecord {
        from_path: row.get(0)?,
        to_raw: row.get(1)?,
        to_path: row.get(2)?,
        kind,
        start_byte: row.get(4)?,
        end_byte: row.get(5)?,
        resolution,
    })
}

const LINK_COLUMNS: &str = "from_path, to_raw, to_path, kind, start_byte, end_byte, resolution";
