//! 搜索取消信号：与库状态锁解耦，调用方可在排名、SQL 或正文求值期间请求终止。

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};

use tantivy::{
    query::{EnableScoring, Explanation, Query, Scorer, Weight},
    DocId, DocSet, Score, SegmentReader, TERMINATED,
};

use crate::Error;

/// 一次搜索任务的协作取消信号；克隆后共享状态，取消不可撤销且不影响写盘。
#[derive(Clone, Default)]
pub struct SearchCancellation(Arc<Cancellation>);

#[derive(Default)]
struct Cancellation {
    cancelled: AtomicBool,
    inference: Mutex<Vec<Weak<ort::session::RunOptions>>>,
}

impl std::fmt::Debug for SearchCancellation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SearchCancellation")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl SearchCancellation {
    /// 请求终止本次搜索；不等待后台线程，也不获取库锁。
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        let active = self
            .0
            .inference
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for options in active.iter().filter_map(Weak::upgrade) {
            // 原生中断仅加快退出；即使运行时拒绝中断，交付前仍以取消标志拒绝结果。
            let _ = options.terminate();
        }
    }

    /// 是否已取消；供查询循环和 SQL progress handler 检查。
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    /// 注册当前推理的终止选项；弱引用不延长已结束推理的资源生命周期。
    pub(crate) fn inference_options(&self) -> Result<Arc<ort::session::RunOptions>, Error> {
        self.check()?;
        let options = Arc::new(ort::session::RunOptions::new().map_err(std::io::Error::other)?);
        let mut active = self
            .0
            .inference
            .lock()
            .map_err(|_| std::io::Error::other("推理取消锁已失效"))?;
        active.retain(|item| item.strong_count() > 0);
        active.push(Arc::downgrade(&options));
        self.check()?;
        Ok(options)
    }

    /// 取消时返回独立错误，禁止把部分命中当作完整的一页。
    pub(crate) fn check(&self) -> Result<(), Error> {
        if self.is_cancelled() {
            Err(Error::SearchCancelled)
        } else {
            Ok(())
        }
    }
}

/// 在引擎的文档游标层检查取消，避免只在 `TopDocs` 全部计算完后丢弃结果。
#[derive(Debug)]
pub(crate) struct CancellableQuery {
    pub query: Box<dyn Query>,
    pub cancellation: SearchCancellation,
}

impl Clone for CancellableQuery {
    fn clone(&self) -> Self {
        Self {
            query: self.query.box_clone(),
            cancellation: self.cancellation.clone(),
        }
    }
}

impl Query for CancellableQuery {
    fn weight(&self, scoring: EnableScoring<'_>) -> tantivy::Result<Box<dyn Weight>> {
        Ok(Box::new(CancellableWeight {
            inner: self.query.weight(scoring)?,
            cancellation: self.cancellation.clone(),
        }))
    }
}

struct CancellableWeight {
    inner: Box<dyn Weight>,
    cancellation: SearchCancellation,
}

impl Weight for CancellableWeight {
    fn scorer(&self, reader: &SegmentReader, boost: Score) -> tantivy::Result<Box<dyn Scorer>> {
        Ok(Box::new(CancellableScorer {
            inner: self.inner.scorer(reader, boost)?,
            cancellation: self.cancellation.clone(),
        }))
    }

    fn explain(&self, reader: &SegmentReader, doc: DocId) -> tantivy::Result<Explanation> {
        self.inner.explain(reader, doc)
    }
}

struct CancellableScorer {
    inner: Box<dyn Scorer>,
    cancellation: SearchCancellation,
}

impl DocSet for CancellableScorer {
    fn advance(&mut self) -> DocId {
        if self.cancellation.is_cancelled() {
            TERMINATED
        } else {
            self.inner.advance()
        }
    }

    fn seek(&mut self, target: DocId) -> DocId {
        if self.cancellation.is_cancelled() {
            TERMINATED
        } else {
            self.inner.seek(target)
        }
    }

    fn doc(&self) -> DocId {
        if self.cancellation.is_cancelled() {
            TERMINATED
        } else {
            self.inner.doc()
        }
    }

    fn size_hint(&self) -> u32 {
        self.inner.size_hint()
    }
}

impl Scorer for CancellableScorer {
    fn score(&mut self) -> Score {
        self.inner.score()
    }
}
