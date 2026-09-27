//! 将 `SQLite` 来源集合映射为当前排名段内的文档集合，不读取正文或改动倒排格式。

use std::{collections::HashSet, sync::Arc};

use tantivy::{
    query::{ConstScorer, EmptyScorer, EnableScoring, Explanation, Query, Scorer, Weight},
    DocId, DocSet, Score, SegmentReader, TERMINATED,
};

use crate::SearchCancellation;

/// 短词与元数据只决定候选资格，不通过命中分支数量给相关度额外加分。
#[derive(Clone, Debug)]
pub(crate) struct SourceQuery {
    sources: Arc<HashSet<u64>>,
    cancellation: SearchCancellation,
}

impl SourceQuery {
    /// 来源行号必须属于同一 SQLite／排名快照；取消信号贯穿段内集合构建。
    pub fn new(sources: HashSet<u64>, cancellation: SearchCancellation) -> Self {
        Self {
            sources: Arc::new(sources),
            cancellation,
        }
    }
}

impl Query for SourceQuery {
    fn weight(&self, _scoring: EnableScoring<'_>) -> tantivy::Result<Box<dyn Weight>> {
        Ok(Box::new(self.clone()))
    }
}

impl Weight for SourceQuery {
    fn scorer(&self, reader: &SegmentReader, _boost: Score) -> tantivy::Result<Box<dyn Scorer>> {
        if self.sources.is_empty() {
            return Ok(Box::new(EmptyScorer));
        }
        let field = reader.fast_fields().u64("source")?;
        let mut docs = Vec::new();
        for doc in 0..reader.max_doc() {
            if self.cancellation.is_cancelled() {
                // 外层排名查询会将取消报告为错误，不能发布此时的局部结果。
                return Ok(Box::new(EmptyScorer));
            }
            if field
                .first(doc)
                .is_some_and(|source| self.sources.contains(&source))
            {
                docs.push(doc);
            }
        }
        Ok(Box::new(ConstScorer::new(
            SourceDocs { docs, cursor: 0 },
            0.0,
        )))
    }

    fn explain(&self, reader: &SegmentReader, doc: DocId) -> tantivy::Result<Explanation> {
        if !reader
            .fast_fields()
            .u64("source")?
            .first(doc)
            .is_some_and(|source| self.sources.contains(&source))
        {
            return Err(tantivy::TantivyError::InvalidArgument(
                "文档不属于候选来源集合".into(),
            ));
        }
        Ok(Explanation::new("来源条件不增加相关度分数", 0.0))
    }
}

/// 按段内文档号升序排列的来源集合；交集可二分跳过无关文档，不逐条扫描正文。
struct SourceDocs {
    docs: Vec<DocId>,
    cursor: usize,
}

impl DocSet for SourceDocs {
    fn advance(&mut self) -> DocId {
        self.cursor = (self.cursor + 1).min(self.docs.len());
        self.doc()
    }

    fn seek(&mut self, target: DocId) -> DocId {
        self.cursor += self.docs[self.cursor..].partition_point(|doc| *doc < target);
        self.doc()
    }

    fn doc(&self) -> DocId {
        self.docs.get(self.cursor).copied().unwrap_or(TERMINATED)
    }

    fn size_hint(&self) -> u32 {
        u32::try_from(self.docs.len()).unwrap_or(u32::MAX)
    }
}
