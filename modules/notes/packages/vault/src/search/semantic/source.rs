//! 单篇派生输入的捕获与条件发布；耗时推理与数据库写事务隔离。

use super::model::VERSION;
use crate::Error;
use rusqlite::{params, Connection, OptionalExtension};
use std::ops::Range;

/// 推理实际读取的输入快照；原始文件哈希不能代替解析后正文的版本。
pub(super) struct SourceSnapshot {
    /// 库内路径，提交时必须仍指向同一输入。
    pub path: String,
    /// 完整派生标题，不能用截断后的模型上下文代替版本校验。
    pub title: String,
    /// 原始文件内容哈希。
    pub content_hash: String,
    /// 模型切块使用的派生正文。
    pub body: String,
    /// 与正文同版的章节边界和源码映射。
    pub source_map: String,
}

/// 尚未发布的文本块，只有完整输入快照仍成立时才能进入有效索引。
pub(super) struct EncodedChunk {
    /// 派生正文内的 UTF-8 字节范围。
    pub range: Range<usize>,
    /// 包含标题上下文的完整模型输入哈希。
    pub input_hash: String,
    /// 已校验并按小端格式编码的向量。
    pub vector: Vec<u8>,
}

/// 从当前模型的持久待处理集合读取一篇；空集合返回 None，SQL 错误原样传播。
pub(super) fn next(conn: &Connection) -> Result<Option<SourceSnapshot>, Error> {
    Ok(conn.query_row(
        "SELECT f.path, f.title, f.content_hash, s.body, s.source_map FROM files f JOIN search_sources s ON s.path = f.path LEFT JOIN semantic_documents d ON d.path = f.path WHERE d.path IS NULL OR d.content_hash != f.content_hash OR d.model != ? ORDER BY f.path LIMIT 1",
        [VERSION], |row| Ok(SourceSnapshot {
            path: row.get(0)?, title: row.get(1)?, content_hash: row.get(2)?, body: row.get(3)?, source_map: row.get(4)?,
        }),
    ).optional()?)
}

/// 原子发布块与完成标记；输入已变时返回 false，写入或提交错误传播给后台任务。
pub(super) fn publish(
    conn: &mut Connection,
    source: &SourceSnapshot,
    chunks: Vec<EncodedChunk>,
) -> Result<bool, Error> {
    let tx = conn.transaction()?;
    let current: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM files f JOIN search_sources s ON s.path = f.path WHERE f.path = ? AND f.content_hash = ? AND f.title = ? AND s.body = ? AND s.source_map = ?)",
        params![source.path, source.content_hash, source.title, source.body, source.source_map], |row| row.get(0),
    )?;
    if !current {
        return Ok(false);
    }
    tx.execute("DELETE FROM semantic_chunks WHERE path = ?", [&source.path])?;
    for chunk in chunks {
        tx.execute(
            "INSERT OR IGNORE INTO semantic_embeddings(model, input_hash, vector) VALUES (?, ?, ?)",
            params![VERSION, chunk.input_hash, chunk.vector],
        )?;
        tx.execute("INSERT INTO semantic_chunks(path, content_hash, embedding_id, start_byte, end_byte) SELECT ?, ?, id, ?, ? FROM semantic_embeddings WHERE model = ? AND input_hash = ?", params![source.path, source.content_hash, i64::try_from(chunk.range.start).map_err(std::io::Error::other)?, i64::try_from(chunk.range.end).map_err(std::io::Error::other)?, VERSION, chunk.input_hash])?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO semantic_documents(path, content_hash, model) VALUES (?, ?, ?)",
        params![source.path, source.content_hash, VERSION],
    )?;
    tx.commit()?;
    Ok(true)
}
