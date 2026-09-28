//! 长词排名索引：正文由 `SQLite` 持有，Tantivy 只保存倒排数据和来源行号。
//!
//! 待同步路径与正文在同一 `SQLite` 事务提交。短暂持有写事务，同步排名并建立
//! 同版本只读快照后释放；确认失败可幂等重试，缺失索引可从正文完整重建。

mod sources;

pub(crate) use sources::SourceQuery;

use std::{io, path::Path};

use rusqlite::Connection;
use tantivy::{
    collector::TopDocs,
    directory::MmapDirectory,
    query::{BooleanQuery, BoostQuery, Occur, PhraseQuery, Query, TermQuery},
    schema::{Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, FAST, STRING},
    tokenizer::{NgramTokenizer, Token, TokenStream, Tokenizer},
    Index, IndexReader, IndexWriter, ReloadPolicy, Searcher, TantivyDocument, Term,
};

use crate::{
    error::Error, search::cancellation::CancellableQuery, markdown::source_map::fold, SearchCancellation,
};

/// 三字片段必须具有相邻位置，才能证明任意长度子串；默认 n-gram 的同位词语义不适用。
#[derive(Clone)]
struct Trigrams(NgramTokenizer);

/// 在固定宽度的 n-gram 流上记录字符位置；保留分词器提供的 UTF-8 字节边界。
struct Positions<'a> {
    inner: <NgramTokenizer as Tokenizer>::TokenStream<'a>,
    next: usize,
}

impl Tokenizer for Trigrams {
    type TokenStream<'a> = Positions<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Positions<'a> {
        Positions {
            inner: self.0.token_stream(text),
            next: 0,
        }
    }
}

impl TokenStream for Positions<'_> {
    fn advance(&mut self) -> bool {
        if !self.inner.advance() {
            return false;
        }
        self.inner.token_mut().position = self.next;
        self.next += 1;
        true
    }

    fn token(&self) -> &Token {
        self.inner.token()
    }

    fn token_mut(&mut self) -> &mut Token {
        self.inner.token_mut()
    }
}

/// 单库排名索引；写入器仅在同步期间持有，允许多个 Vault 依次同步同一派生库。
pub(crate) struct SearchIndex {
    index: Index,
    reader: IndexReader,
    path: Field,
    source: Field,
    title: Field,
    body: Field,
    revision: Option<String>,
}

impl SearchIndex {
    /// 打开版本化派生目录；目录丢失时创建空索引，损坏或不可写时返回可见错误。
    pub fn open(index_dir: &Path) -> Result<Self, Error> {
        match Self::open_existing(index_dir) {
            Err(Error::Io(error))
                if error
                    .get_ref()
                    .and_then(|source| source.downcast_ref::<tantivy::TantivyError>())
                    .is_some_and(|error| {
                        matches!(
                            error,
                            tantivy::TantivyError::DataCorruption(_)
                                | tantivy::TantivyError::DeserializeError(_)
                                | tantivy::TantivyError::IncompatibleIndex(_)
                                | tantivy::TantivyError::SchemaError(_)
                                | tantivy::TantivyError::OpenReadError(
                                    tantivy::directory::error::OpenReadError::FileDoesNotExist(_)
                                )
                        )
                    }) =>
            {
                // 排名目录完全由 SQLite 正文派生；仅识别到损坏或版本不兼容时重建。
                std::fs::remove_dir_all(index_dir.join("search-v1"))?;
                Self::open_existing(index_dir)
            }
            result => result,
        }
    }

    fn open_existing(index_dir: &Path) -> Result<Self, Error> {
        let directory = index_dir.join("search-v1");
        std::fs::create_dir_all(&directory)?;
        let mut schema = Schema::builder();
        let path = schema.add_text_field("path", STRING);
        let source = schema.add_u64_field("source", FAST);
        let text = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("trigram")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        );
        let title = schema.add_text_field("title", text.clone());
        let body = schema.add_text_field("body", text);
        let mut index = Index::open_or_create(
            MmapDirectory::open(directory).map_err(io::Error::other)?,
            schema.build(),
        )
        .map_err(io::Error::other)?;
        // 常见词需在多个段上计算全局排名；每库复用有上限的线程池，不随并发查询增建线程。
        let search_threads =
            std::thread::available_parallelism().map_or(1, |count| count.get().min(4));
        if search_threads > 1 {
            index
                .set_multithread_executor(search_threads)
                .map_err(io::Error::other)?;
        }
        index.tokenizers().register(
            "trigram",
            Trigrams(NgramTokenizer::new(3, 3, false).map_err(io::Error::other)?),
        );
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(io::Error::other)?;
        Ok(Self {
            index,
            reader,
            path,
            source,
            title,
            body,
            revision: None,
        })
    }

    /// 同步到当前 `SQLite` 快照；调用方须持有 IMMEDIATE 事务直到建立同版本读快照。
    ///
    /// 版本由库身份和单调序号组成，来源表被重建后不能复用旧 rowid。提交排名索引
    /// 成功后才清理待同步路径；任一步失败均返回错误，下一次调用可重新确认或重放。
    pub fn synchronize(
        &mut self,
        conn: &Connection,
        cancellation: &SearchCancellation,
        progress: &mut dyn FnMut(usize, Option<usize>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        cancellation.check()?;
        let (epoch, revision): (String, i64) = conn.query_row(
            "SELECT epoch, revision FROM search_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let revision = format!("{epoch}:{revision}");
        let pending: bool =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM search_pending)", [], |row| {
                row.get(0)
            })?;
        if self.revision.as_ref() != Some(&revision) {
            let committed = self.index.load_metas().map_err(io::Error::other)?.payload;
            if committed.as_ref() != Some(&revision) {
                let rebuild = !pending
                    || committed
                        .as_deref()
                        .and_then(|value| value.split_once(':'))
                        .is_none_or(|(identity, _)| identity != epoch);
                self.publish(conn, &revision, rebuild, cancellation, progress)?;
            }
            self.reader.reload().map_err(io::Error::other)?;
            self.revision = Some(revision);
        }
        cancellation.check()?;
        if pending {
            conn.execute("DELETE FROM search_pending", [])?;
        }
        Ok(())
    }

    /// 发布一个完整版本；删除后再新增同路径，使中断重试和 rowid 复用保持幂等。
    fn publish(
        &self,
        conn: &Connection,
        revision: &str,
        rebuild: bool,
        cancellation: &SearchCancellation,
        progress: &mut dyn FnMut(usize, Option<usize>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let total: i64 = conn.query_row(
            if rebuild {
                "SELECT count(*) FROM search_sources"
            } else {
                "SELECT count(*) FROM search_pending"
            },
            [],
            |row| row.get(0),
        )?;
        let total = usize::try_from(total).map_err(io::Error::other)?;
        progress(0, Some(total))?;
        let mut writer: IndexWriter<TantivyDocument> = self
            .index
            .writer_with_num_threads(1, 50_000_000)
            .map_err(io::Error::other)?;
        if rebuild {
            writer.delete_all_documents().map_err(io::Error::other)?;
        }
        let sql = if rebuild {
            "SELECT ss.path, f.title, ss.body, ss.rowid FROM search_sources ss JOIN files f ON f.path = ss.path"
        } else {
            "SELECT p.path, f.title, ss.body, ss.rowid FROM search_pending p LEFT JOIN search_sources ss ON ss.path = p.path LEFT JOIN files f ON f.path = ss.path"
        };
        let mut statement = conn.prepare(sql)?;
        let mut rows = statement.query([])?;
        let mut completed = 0_usize;
        while let Some(row) = rows.next()? {
            cancellation.check()?;
            completed += 1;
            let path: String = row.get(0)?;
            if !rebuild {
                writer.delete_term(Term::from_field_text(self.path, &path));
            }
            if let Some(source) = row.get::<_, Option<i64>>(3)? {
                let source = u64::try_from(source).map_err(io::Error::other)?;
                let title: String = row.get(1)?;
                let body: String = row.get(2)?;
                let mut document = TantivyDocument::new();
                document.add_text(self.path, path);
                document.add_u64(self.source, source);
                document.add_text(self.title, fold(&title));
                document.add_text(self.body, fold(&body));
                writer.add_document(document).map_err(io::Error::other)?;
            }
            if completed.is_multiple_of(32) {
                progress(completed, Some(total))?;
            }
        }
        cancellation.check()?;
        progress(completed, Some(total))?;
        let mut commit = writer.prepare_commit().map_err(io::Error::other)?;
        commit.set_payload(revision);
        commit.commit().map_err(io::Error::other)?;
        writer.wait_merging_threads().map_err(io::Error::other)?;
        progress(completed, Some(total))?;
        Ok(())
    }

    /// 捕获不可变排名快照；须在同步和建立正文快照的临界区内调用。
    pub fn snapshot(&self) -> Result<SearchSnapshot, Error> {
        Ok(SearchSnapshot {
            searcher: self.reader.searcher(),
            title: self.title,
            body: self.body,
            revision: self
                .revision
                .clone()
                .ok_or_else(|| io::Error::other("排名索引尚未同步"))?,
        })
    }
}

/// 与正文事务版本一致的不可变排名视图；查询期间不再持有索引锁。
pub(crate) struct SearchSnapshot {
    searcher: Searcher,
    title: Field,
    body: Field,
    pub revision: String,
}

impl SearchSnapshot {
    /// 防止损坏的续页位置使 `TopDocs` 分配超出库规模的堆。
    pub fn documents(&self) -> u64 {
        self.searcher.num_docs()
    }

    /// 长词可命中标题或正文，标题 BM25 权重为 5；输入须规范化且至少三个字符。
    pub fn term_query(&self, term: &str) -> Box<dyn Query> {
        Box::new(BooleanQuery::new(vec![
            (
                Occur::Should,
                Box::new(BoostQuery::new(phrase(self.title, term), 5.0)),
            ),
            (Occur::Should, phrase(self.body, term)),
        ]))
    }

    /// 以同一 reader 快照执行所有分页；候选筛选发生在结果上限之前。
    /// 仅返回来源行号，正文与准确位置仍从 `SQLite` 读取并校验完整表达式。
    pub fn ranked(&self, query: Box<dyn Query>, cancellation: &SearchCancellation) -> RankedQuery {
        RankedQuery {
            searcher: self.searcher.clone(),
            query: CancellableQuery {
                query,
                cancellation: cancellation.clone(),
            },
        }
    }
}

/// 具有固定索引快照的排名查询；后置条件不足一页时可以继续取候选，不截断召回。
pub(crate) struct RankedQuery {
    searcher: Searcher,
    query: CancellableQuery,
}

impl RankedQuery {
    /// 返回全局排名中的一个区间；同分快照内使用引擎的文档地址稳定排序。
    ///
    /// `limit` 必须大于零；读取索引失败或来源行号不合法时返回错误。
    pub fn page(&self, offset: usize, limit: usize) -> Result<Vec<i64>, Error> {
        self.query.cancellation.check()?;
        let remaining = usize::try_from(self.searcher.num_docs())
            .unwrap_or(usize::MAX)
            .saturating_sub(offset);
        if remaining == 0 {
            return Ok(Vec::new());
        }
        let limit = limit.min(remaining);
        let top = TopDocs::with_limit(limit)
            .and_offset(offset)
            .order_by_score();
        let docs = self
            .searcher
            .search(&self.query, &top)
            .map_err(io::Error::other)?;
        self.query.cancellation.check()?;
        docs.into_iter()
            .map(|(_, address)| {
                let field = self
                    .searcher
                    .segment_reader(address.segment_ord)
                    .fast_fields()
                    .u64("source")
                    .map_err(io::Error::other)?;
                let source = field
                    .first(address.doc_id)
                    .ok_or_else(|| io::Error::other("排名索引缺少来源行号"))?;
                i64::try_from(source).map_err(|error| io::Error::other(error).into())
            })
            .collect()
    }
}

/// 用覆盖全部字符的三字片段证明子串：每隔三字取一段，尾部不足三字时补最后一段。
/// 显式位置保持完整短语约束，避免对每个重叠片段重复求交；重复片段不能去重。
fn phrase(field: Field, text: &str) -> Box<dyn Query> {
    let boundaries = text
        .char_indices()
        .map(|(offset, _)| offset)
        .chain(std::iter::once(text.len()))
        .collect::<Vec<_>>();
    let last = boundaries.len() - 4;
    let offsets = (0..=last).step_by(3).chain((last % 3 != 0).then_some(last));
    let mut terms = offsets
        .map(|offset| {
            (
                offset,
                Term::from_field_text(field, &text[boundaries[offset]..boundaries[offset + 3]]),
            )
        })
        .collect::<Vec<_>>();
    if terms.len() == 1 {
        Box::new(TermQuery::new(
            terms.remove(0).1,
            IndexRecordOption::WithFreqs,
        ))
    } else {
        Box::new(PhraseQuery::new_with_offset(terms))
    }
}
