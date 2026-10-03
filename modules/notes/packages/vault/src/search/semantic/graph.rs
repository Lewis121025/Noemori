//! HNSW 从持久向量和变更日志恢复；查询过滤掉与正文版本不一致的节点。

use super::{
    decode,
    model::{failure, DIMENSIONS, VERSION},
};
use crate::search::hybrid::{VectorHit, VectorRecall};
use crate::{Error, SearchCancellation};
use rusqlite::{Connection, OptionalExtension};
use std::io::Write;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

/// 固定模型的中英文正负样本校准下限，只排除明显无关项，不是置信概率。
const MIN_SIMILARITY: f32 = 0.30;

/// 当前模型和缓存代次的内存图；持久检查点只在完整写入后可复用。
#[derive(Default)]
pub(super) struct Graph {
    index: Option<Index>,
    epoch: String,
    applied: i64,
    removed: usize,
    dirty: bool,
}

impl Graph {
    /// 按 conn 的快照追平图并保存到 directory；图操作、SQL、磁盘和取消错误传播。
    pub fn synchronize(
        &mut self,
        conn: &Connection,
        directory: &Path,
        token: &SearchCancellation,
    ) -> Result<(), Error> {
        let epoch: String =
            conn.query_row("SELECT epoch FROM semantic_state WHERE id = 1", [], |r| {
                r.get(0)
            })?;
        let revision: i64 = conn.query_row(
            "SELECT coalesce(max(seq), 0) FROM semantic_changes",
            [],
            |r| r.get(0),
        )?;
        if self.index.is_some() && self.epoch == epoch && self.applied == revision {
            return self.flush(directory, token);
        }
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM semantic_embeddings WHERE model = ?",
            [VERSION],
            |r| r.get(0),
        )?;
        let count = usize::try_from(count).map_err(failure)?;
        let first: i64 = conn.query_row(
            "SELECT coalesce(min(seq), 0) FROM semantic_changes",
            [],
            |r| r.get(0),
        )?;
        let rebuild = self.index.is_none()
            || first > self.applied.saturating_add(1)
            || self.epoch != epoch
            || self.applied > revision
            || self.removed > count.max(1000) / 4;
        if rebuild {
            let (index, dirty) = rebuild_index(
                conn,
                directory,
                &epoch,
                revision,
                count,
                self.removed > 0,
                token,
            )?;
            self.index = Some(index);
            self.epoch = epoch;
            self.applied = revision;
            self.removed = 0;
            self.dirty = dirty;
        } else {
            self.dirty = true;
            let index = self.index.as_ref().ok_or_else(|| failure("图尚未初始化"))?;
            index
                .reserve((index.size() + count).max(1))
                .map_err(failure)?;
            let mut stmt = conn.prepare(
                "SELECT seq, embedding_id, deleted FROM semantic_changes WHERE seq > ? ORDER BY seq",
            )?;
            let mut rows = stmt.query([self.applied])?;
            while let Some(row) = rows.next()? {
                token.check()?;
                let id = u64::try_from(row.get::<_, i64>(1)?).map_err(failure)?;
                if row.get::<_, bool>(2)? {
                    self.removed += index.remove(id).map_err(failure)?;
                } else {
                    let vector: Option<Vec<u8>> = conn
                        .query_row(
                            "SELECT vector FROM semantic_embeddings WHERE id = ? AND model = ?",
                            rusqlite::params![i64::try_from(id).map_err(failure)?, VERSION],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if let Some(vector) = vector {
                        index.remove(id).map_err(failure)?;
                        index.add(id, &decode(&vector)?).map_err(failure)?;
                    }
                }
                self.applied = row.get(0)?;
            }
        }
        token.check()?;
        if self.removed > count.max(1000) / 4 {
            self.index = Some(
                rebuild_index(
                    conn,
                    directory,
                    &self.epoch,
                    self.applied,
                    count,
                    true,
                    token,
                )?
                .0,
            );
            self.removed = 0;
        }
        self.flush(directory, token)
    }

    /// 内存已更新但磁盘提交失败时保留 dirty；下次查询或后台发布必须重试检查点。
    fn flush(&mut self, directory: &Path, token: &SearchCancellation) -> Result<(), Error> {
        if self.dirty {
            self.checkpoint(directory, token)?;
            self.dirty = false;
        }
        Ok(())
    }

    fn checkpoint(&self, directory: &Path, token: &SearchCancellation) -> Result<(), Error> {
        let stage = tempfile::NamedTempFile::new_in(directory)?;
        let index = self.index.as_ref().ok_or_else(|| failure("图尚未初始化"))?;
        index
            .save(
                stage
                    .path()
                    .to_str()
                    .ok_or_else(|| failure("索引路径不是 UTF-8"))?,
            )
            .map_err(failure)?;
        stage.as_file().sync_all()?;
        let digest = graph_hash(stage.path(), token)?;
        token.check()?;
        stage
            .persist(directory.join("semantic.usearch"))
            .map_err(|e| e.error)?;
        let mut manifest = tempfile::NamedTempFile::new_in(directory)?;
        write!(
            manifest,
            "{}:{}:{}:{}",
            VERSION, self.epoch, self.applied, digest
        )?;
        manifest.as_file().sync_all()?;
        manifest
            .persist(directory.join("semantic.checkpoint"))
            .map_err(|e| e.error)?;
        Ok(())
    }

    /// 用归一化 vector 搜索 eligible 内的有效文本块；返回有界候选及截断标记。
    /// conn 与 eligible 必须同版，图同步、查询和取消错误传播。
    pub fn search(
        &mut self,
        conn: &Connection,
        directory: &Path,
        vector: &[f32],
        eligible: &HashSet<u64>,
        token: &SearchCancellation,
    ) -> Result<VectorRecall, Error> {
        self.synchronize(conn, directory, token)?;
        let metadata = locations(conn, eligible, token)?;
        let index = self.index.as_ref().ok_or_else(|| failure("向量索引缺失"))?;
        if metadata.len() <= 1000 {
            return exact_filtered(index, vector, &metadata, token);
        }
        let mut count = 400.min(metadata.len());
        loop {
            token.check()?;
            index.change_expansion_search(count.max(400));
            let result = index
                .filtered_search(vector, count, |id| metadata.contains_key(&id))
                .map_err(failure)?;
            let mut hits = expand(
                result
                    .keys
                    .into_iter()
                    .zip(result.distances)
                    .filter(|(_, distance)| 1.0 - distance >= MIN_SIMILARITY)
                    .map(|(id, _)| id),
                &metadata,
            );
            if hits.limited || count >= metadata.len() || count >= 3200 {
                hits.limited |= count < metadata.len();
                token.check()?;
                return Ok(hits);
            }
            count = (count * 2).min(metadata.len()).min(3200);
        }
    }
}

/// 加载失败后的原生实例不可复用，必须重新分配容量后从持久向量重建。
fn rebuild_index(
    conn: &Connection,
    directory: &Path,
    epoch: &str,
    revision: i64,
    count: usize,
    compact: bool,
    token: &SearchCancellation,
) -> Result<(Index, bool), Error> {
    let mut index = create_index(count)?;
    let checkpoint = directory.join("semantic.usearch");
    let expected = format!("{VERSION}:{epoch}:{revision}");
    let manifest_matches = !compact
        && match fs::read_to_string(directory.join("semantic.checkpoint")) {
            Ok(value) => match value.rsplit_once(':') {
                Some((version, digest)) if version == expected && checkpoint.is_file() => {
                    digest == graph_hash(&checkpoint, token)?
                }
                _ => false,
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.into()),
        };
    let loaded = manifest_matches
        && index
            .load(
                checkpoint
                    .to_str()
                    .ok_or_else(|| failure("索引路径不是 UTF-8"))?,
            )
            .is_ok();
    if !loaded {
        index = create_index(count)?;
        let mut stmt =
            conn.prepare("SELECT id, vector FROM semantic_embeddings WHERE model = ? ORDER BY id")?;
        let mut rows = stmt.query([VERSION])?;
        while let Some(row) = rows.next()? {
            token.check()?;
            index
                .add(
                    u64::try_from(row.get::<_, i64>(0)?).map_err(failure)?,
                    &decode(&row.get::<_, Vec<u8>>(1)?)?,
                )
                .map_err(failure)?;
        }
    }
    Ok((index, !loaded))
}

fn create_index(count: usize) -> Result<Index, Error> {
    let index = Index::new(&IndexOptions {
        dimensions: DIMENSIONS,
        metric: MetricKind::Cos,
        quantization: ScalarKind::F32,
        connectivity: 16,
        expansion_add: 200,
        expansion_search: 400,
        multi: false,
    })
    .map_err(failure)?;
    index.reserve(count.max(1)).map_err(failure)?;
    Ok(index)
}

/// 图是可重建缓存，校验和防止有效头部后面的静默位损坏改变召回结果。
fn graph_hash(path: &Path, token: &SearchCancellation) -> Result<String, Error> {
    let mut file = fs::File::open(path)?;
    let (hash, _) = crate::storage::hash::transfer_hashed(
        &mut file,
        &mut std::io::sink(),
        u64::MAX,
        &mut |_| token.check(),
    )?;
    Ok(hash)
}

/// 强筛选的小集合用精确距离，避免 HNSW 在稀疏子图上漏召回。
fn exact_filtered(
    index: &Index,
    query: &[f32],
    metadata: &HashMap<u64, Vec<VectorHit>>,
    token: &SearchCancellation,
) -> Result<VectorRecall, Error> {
    let mut ranked = Vec::new();
    let mut vector = vec![0.0_f32; DIMENSIONS];
    for id in metadata.keys() {
        token.check()?;
        if index.get(*id, &mut vector).map_err(failure)? != 1 {
            return Err(failure("图缺少已发布向量"));
        }
        let similarity = vector.iter().zip(query).map(|(a, b)| a * b).sum::<f32>();
        if similarity >= MIN_SIMILARITY {
            ranked.push((similarity, *id));
        }
    }
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    Ok(expand(ranked.into_iter().map(|(_, id)| id), metadata))
}

/// 相同模型输入只有一个向量，展开其全部有效文件位置后再按文件去重。
fn expand(ids: impl Iterator<Item = u64>, metadata: &HashMap<u64, Vec<VectorHit>>) -> VectorRecall {
    let mut recall = VectorRecall::default();
    let mut seen = HashSet::new();
    for id in ids {
        if let Some(locations) = metadata.get(&id) {
            for location in locations {
                if seen.insert(location.source) {
                    if recall.hits.len() == 200 {
                        recall.limited = true;
                        return recall;
                    }
                    recall.hits.push(location.clone());
                }
            }
        }
    }
    recall
}

fn locations(
    conn: &Connection,
    eligible: &HashSet<u64>,
    token: &SearchCancellation,
) -> Result<HashMap<u64, Vec<VectorHit>>, Error> {
    let mut metadata: HashMap<u64, Vec<VectorHit>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT c.embedding_id, s.rowid, c.start_byte, c.end_byte FROM semantic_chunks c JOIN semantic_embeddings e ON e.id = c.embedding_id JOIN files f ON f.path = c.path AND f.content_hash = c.content_hash JOIN search_sources s ON s.path = c.path JOIN semantic_documents d ON d.path = c.path AND d.content_hash = c.content_hash AND d.model = e.model WHERE e.model = ? ORDER BY c.path, c.start_byte")?;
    let mut rows = stmt.query([VERSION])?;
    while let Some(row) = rows.next()? {
        token.check()?;
        let source = u64::try_from(row.get::<_, i64>(1)?).map_err(failure)?;
        if eligible.contains(&source) {
            metadata
                .entry(u64::try_from(row.get::<_, i64>(0)?).map_err(failure)?)
                .or_default()
                .push(VectorHit {
                    source,
                    start: usize::try_from(row.get::<_, i64>(2)?).map_err(failure)?,
                    end: usize::try_from(row.get::<_, i64>(3)?).map_err(failure)?,
                });
        }
    }
    Ok(metadata)
}
