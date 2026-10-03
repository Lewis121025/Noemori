//! 语义索引是可重放的派生物：正文版本决定可见性，模型推理不持有写事务。

mod graph;
mod model;
mod source;

#[cfg(test)]
#[path = "../../../../../../test/notes/vault/unit/search/semantic.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../../../../test/notes/vault/performance/search/hybrid.rs"]
mod performance;

use super::hybrid::{SemanticState, SemanticStatus, VectorRecall};
use crate::{Error, SearchCancellation, Vault};
use model::{failure, Harrier, VERSION};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, TryLockError},
    time::Duration,
};

/// 模型锁只覆盖单次推理；图与错误状态各自加锁，查询不等待整个建库任务。
pub(crate) struct Semantic {
    root: Mutex<PathBuf>,
    model: Mutex<Option<Harrier>>,
    graph: Mutex<graph::Graph>,
    error: Mutex<Option<String>>,
    indexing: Mutex<()>,
}

impl Semantic {
    /// 为单库创建惰性缓存；index 是派生目录，构造时不加载模型或正文。
    pub fn new(index: &Path) -> Self {
        Self {
            root: Mutex::new(index.join("models").join(model::MODEL_DIRECTORY)),
            model: Mutex::new(None),
            graph: Mutex::new(graph::Graph::default()),
            error: Mutex::new(None),
            indexing: Mutex::new(()),
        }
    }

    /// 开库提交前设置共享模型根目录；锁失效时返回错误。
    pub fn configure(&self, directory: &Path) -> Result<(), Error> {
        *lock(&self.root)? = directory.join(model::MODEL_DIRECTORY);
        *lock(&self.model)? = None;
        Ok(())
    }

    /// source 为空时下载，否则导入目录；成功表示制品就绪，取消和 IO 错误传播。
    pub fn install(&self, source: Option<&Path>, token: &SearchCancellation) -> Result<(), Error> {
        let _guard = lock_cancellable(&self.indexing, token)?;
        let root = lock(&self.root)?.clone();
        let result = model::install(&root, source, token);
        if result.is_err() && token.is_cancelled() {
            return Err(Error::SearchCancelled);
        }
        if result.is_ok() {
            *lock(&self.model)? = None;
        }
        *lock(&self.error)? = result.as_ref().err().map(ToString::to_string);
        result
    }

    fn with_model<T>(
        &self,
        token: &SearchCancellation,
        f: impl FnOnce(&mut Harrier) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut slot = lock_cancellable(&self.model, token)?;
        if slot.is_none() {
            let root = lock(&self.root)?.clone();
            *slot = Some(Harrier::open(&root, token)?);
        }
        f(slot.as_mut().ok_or_else(|| failure("模型初始化未完成"))?)
    }

    /// 编码已验证的自然语言 text；未安装返回 None，取消、加载或推理失败返回错误。
    pub fn query_vector(
        &self,
        text: &str,
        token: &SearchCancellation,
    ) -> Result<Option<Vec<f32>>, Error> {
        token.check()?;
        if !model::installed(&lock(&self.root)?) {
            return Ok(None);
        }
        self.with_model(token, |model| model.encode(text, true, token))
            .map(Some)
    }

    /// 在 conn 的视图内统计覆盖与错误状态；不加载模型，SQL 和锁错误传播。
    pub fn status(&self, conn: &Connection) -> Result<SemanticStatus, Error> {
        // 两个计数来自同一条 SQL 的快照，外部实例提交时也不会得到 indexed > total。
        let (total, indexed): (i64, i64) = conn.query_row(
            "SELECT count(*), count(d.path) FROM search_sources s JOIN files f ON f.path = s.path LEFT JOIN semantic_documents d ON d.path = f.path AND d.content_hash = f.content_hash AND d.model = ?",
            [VERSION], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let state = if let Some(message) = lock(&self.error)?.clone() {
            SemanticState::Failed { message }
        } else if !model::installed(&lock(&self.root)?) {
            SemanticState::Missing
        } else if indexed < total {
            SemanticState::Indexing
        } else {
            SemanticState::Ready
        };
        Ok(SemanticStatus {
            state,
            indexed,
            total,
        })
    }

    /// 数据库中的未完成版本就是持久任务队列；崩溃后无需猜测上次批次是否已提交。
    pub fn synchronize(&self, vault: &Vault, token: &SearchCancellation) -> Result<(), Error> {
        let _guard = lock_cancellable(&self.indexing, token)?;
        if !model::installed(&lock(&self.root)?) {
            return Ok(());
        }
        let result = self.index_pending(vault, token);
        token.check()?;
        if !matches!(result, Err(Error::SearchCancelled)) {
            *lock(&self.error)? = result.as_ref().err().map(ToString::to_string);
        }
        result
    }

    fn index_pending(&self, vault: &Vault, token: &SearchCancellation) -> Result<(), Error> {
        loop {
            token.check()?;
            let pending = source::next(&*vault.lock_conn()?)?;
            let Some(snapshot) = pending else {
                break;
            };
            let source_map: crate::markdown::source_map::SourceMap =
                serde_json::from_str(&snapshot.source_map).map_err(failure)?;
            let body = &snapshot.body;
            let mut ranges =
                self.with_model(token, |model| model.ranges(body, &source_map.sections))?;
            if ranges.is_empty() {
                ranges.push(0..0);
            }
            let title = snapshot.title.chars().take(160).collect::<String>();
            let mut chunks = Vec::new();
            for range in ranges {
                token.check()?;
                let heading = source_map
                    .sections
                    .iter()
                    .rev()
                    .find(|start| **start <= range.start)
                    .and_then(|start| body[*start..].lines().next())
                    .unwrap_or("")
                    .chars()
                    .take(160)
                    .collect::<String>();
                let input = format!("{title}\n{heading}\n{}", &body[range.clone()]);
                let input_hash = crate::vault::hex_digest(&Sha256::digest(input.as_bytes()));
                let cached: Option<Vec<u8>> = vault
                    .lock_conn()?
                    .query_row(
                        "SELECT vector FROM semantic_embeddings WHERE input_hash = ? AND model = ?",
                        params![input_hash, VERSION],
                        |r| r.get(0),
                    )
                    .optional()?;
                let vector = if let Some(cached) = cached {
                    decode(&cached)?
                } else {
                    self.with_model(token, |model| model.encode(&input, false, token))?
                };
                chunks.push(source::EncodedChunk {
                    range,
                    input_hash,
                    vector: encode(&vector),
                });
            }
            token.check()?;
            let mut conn = vault.lock_conn()?;
            source::publish(&mut conn, &snapshot, chunks)?;
        }
        token.check()?;
        vault.lock_conn()?.execute("DELETE FROM semantic_embeddings WHERE NOT EXISTS (SELECT 1 FROM semantic_chunks WHERE embedding_id = semantic_embeddings.id)", [])?;
        let conn = crate::index::open_search_reader(&vault.index_dir().join("index.sqlite"))?;
        conn.execute_batch("BEGIN DEFERRED")?;
        lock_cancellable(&self.graph, token)?.synchronize(&conn, vault.index_dir(), token)?;
        // 保留最新日志窗口；较旧图检测到序号缺口后从向量重建，不猜测已删除节点。
        let last: i64 = conn.query_row(
            "SELECT coalesce(max(seq), 0) FROM semantic_changes",
            [],
            |r| r.get(0),
        )?;
        drop(conn);
        vault.lock_conn()?.execute(
            "DELETE FROM semantic_changes WHERE seq < ?",
            [last.saturating_sub(10_000)],
        )?;
        Ok(())
    }

    /// vector 是当前模型的归一化向量；按 conn 的来源集合筛选，索引和取消错误传播。
    pub fn retrieve(
        &self,
        conn: &Connection,
        directory: &Path,
        vector: &[f32],
        eligible: &HashSet<u64>,
        token: &SearchCancellation,
    ) -> Result<VectorRecall, Error> {
        lock_cancellable(&self.graph, token)?.search(conn, directory, vector, eligible, token)
    }
}

/// 原子建立语义派生表；部分缓存缺失时整体失效，保留正文与其他功能的数据。
/// `conn` 已建立正文索引表；SQL 或事务提交失败时传播错误。
pub(crate) fn initialize(conn: &Connection) -> Result<(), Error> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let tables: i64 = tx.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('semantic_documents', 'semantic_embeddings', 'semantic_chunks', 'semantic_changes')", [], |row| row.get(0))?;
    if tables != 0 && tables != 4 {
        tx.execute_batch(
            "DROP TRIGGER IF EXISTS semantic_source_insert;
            DROP TRIGGER IF EXISTS semantic_source_update;
            DROP TRIGGER IF EXISTS semantic_source_delete;
            DROP TABLE IF EXISTS semantic_chunks;
            DROP TABLE IF EXISTS semantic_documents;
            DROP TABLE IF EXISTS semantic_embeddings;
            DROP TABLE IF EXISTS semantic_changes;",
        )?;
    }
    // 完整的既有缓存沿用原图身份；此后语义表重建只推进自己的代次。
    tx.execute_batch("CREATE TABLE IF NOT EXISTS semantic_state(id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT NOT NULL);
        INSERT OR IGNORE INTO semantic_state SELECT 1, epoch FROM search_state WHERE id = 1;")?;
    if tables != 4 {
        tx.execute(
            "UPDATE semantic_state SET epoch = lower(hex(randomblob(16))) WHERE id = 1",
            [],
        )?;
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS semantic_documents(path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE, content_hash TEXT NOT NULL, model TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS semantic_embeddings(id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, input_hash TEXT NOT NULL, vector BLOB NOT NULL, UNIQUE(model, input_hash));
        CREATE TABLE IF NOT EXISTS semantic_chunks(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, content_hash TEXT NOT NULL, embedding_id INTEGER NOT NULL REFERENCES semantic_embeddings(id), start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS semantic_chunks_path ON semantic_chunks(path);
        CREATE INDEX IF NOT EXISTS semantic_chunks_embedding ON semantic_chunks(embedding_id);
        CREATE TABLE IF NOT EXISTS semantic_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, embedding_id INTEGER NOT NULL, deleted INTEGER NOT NULL);
        CREATE TRIGGER IF NOT EXISTS semantic_insert AFTER INSERT ON semantic_embeddings BEGIN INSERT INTO semantic_changes(embedding_id, deleted) VALUES(new.id, 0); END;
        CREATE TRIGGER IF NOT EXISTS semantic_delete AFTER DELETE ON semantic_embeddings BEGIN INSERT INTO semantic_changes(embedding_id, deleted) VALUES(old.id, 1); END;")?;
    tx.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS semantic_source_insert AFTER INSERT ON search_sources BEGIN
            DELETE FROM semantic_documents WHERE path = new.path;
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_source_update AFTER UPDATE ON search_sources BEGIN
            DELETE FROM semantic_documents WHERE path IN (old.path, new.path);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_source_delete AFTER DELETE ON search_sources BEGIN
            DELETE FROM semantic_documents WHERE path = old.path;
            DELETE FROM semantic_chunks WHERE path = old.path;
        END;",
    )?;
    tx.commit()?;
    Ok(())
}

fn encode(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}
fn decode(bytes: &[u8]) -> Result<Vec<f32>, Error> {
    if bytes.len() != model::DIMENSIONS * 4 {
        return Err(failure("持久向量长度无效"));
    }
    let values = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect::<Vec<_>>();
    model::normalize(&values)
}
fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, Error> {
    mutex.lock().map_err(|_| failure("语义索引锁已失效"))
}

/// 等待长任务占用的锁也属于可取消阶段；取得锁后再次校验，禁止启动已撤销的工作。
fn lock_cancellable<'a, T>(
    mutex: &'a Mutex<T>,
    token: &SearchCancellation,
) -> Result<MutexGuard<'a, T>, Error> {
    loop {
        token.check()?;
        match mutex.try_lock() {
            Ok(guard) => {
                token.check()?;
                return Ok(guard);
            }
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(10)),
            Err(TryLockError::Poisoned(_)) => return Err(failure("语义索引锁已失效")),
        }
    }
}
