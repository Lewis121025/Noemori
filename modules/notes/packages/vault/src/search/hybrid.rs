//! 融合查询与严格表达式分离；候选窗口冻结后分页，正文版本变化立即失效。

use super::{
    compile, matches, occurrences, Candidate, Cursor, DocContext, Node, Position, DOCUMENT_COLUMNS,
};
use crate::index::fulltext::{lexical, SearchSnapshot, SourceQuery};
use crate::{Error, SearchCancellation, SearchExpr, SearchHit, SearchLocation, SearchQuery};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    time::{Duration, Instant},
};

/// 融合文本与硬性筛选；筛选只允许元数据谓词和它们的布尔组合。
#[derive(Clone, Debug, Serialize)]
pub struct HybridQuery {
    /// 自然语言原文，最多 4096 字节；不能携带严格表达式。
    pub text: String,
    /// 标签、路径、文件名和属性筛选；空 AND 表示不限制。
    pub filter: SearchExpr,
    /// 每页文件数，默认 100、最大 500。
    pub limit: i64,
}

/// 三路召回共享文件身份；证据不能伪装为精确命中数量。
#[derive(Clone, Debug)]
pub struct HybridHit {
    /// 字面命中的既有契约，语义独有结果精确命中数为零。
    pub hit: SearchHit,
    /// 最多三条实际来源证据。
    pub evidence: Vec<HybridEvidence>,
}

/// 召回证据的来源；封闭枚举防止内核生成协议无法解释的字符串。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidenceKind {
    /// 词法索引中的真实词项或笔记身份命中。
    Lexical,
    /// 编辑距离允许范围内的实际词项。
    Fuzzy,
    /// 向量召回的相关文本块，不计入精确命中数。
    Semantic,
}

/// 一条可定位的召回证据；kind 为 lexical、fuzzy 或 semantic。
#[derive(Clone, Debug)]
pub struct HybridEvidence {
    /// 来源路线，不表示置信概率。
    pub kind: EvidenceKind,
    /// 原文摘要，只有字面或纠错词带高亮标记。
    pub snippet: String,
    /// 同内容版本的原文位置；不能证明映射时为空。
    pub location: Option<SearchLocation>,
}

/// 语义路线的可用状态；失败分支携带原因，正常分支不附带错误。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SemanticState {
    /// 尚未安装模型制品。
    Missing,
    /// 已有模型，仍有正文版本等待索引。
    Indexing,
    /// 当前模型的索引已覆盖全部正文。
    Ready,
    /// 模型或索引操作失败，原因必须交付给界面。
    Failed { message: String },
}

/// 语义覆盖与故障显式交付；missing、indexing、ready、error 不混淆为空结果。
#[derive(Clone, Debug)]
pub struct SemanticStatus {
    /// 当前模型与索引可用状态。
    pub state: SemanticState,
    /// 已完成且版本有效的笔记数。
    pub indexed: i64,
    /// 待覆盖的 Markdown 笔记总数。
    pub total: i64,
}

/// 融合页仅覆盖有限候选集合，不承诺枚举所有相关内容。
#[derive(Clone, Debug)]
pub struct HybridPage {
    /// 按固定融合排名排列的文件。
    pub hits: Vec<HybridHit>,
    /// 会话游标，不能复用于其他查询或正文版本。
    pub next_cursor: Option<String>,
    /// 本次查询的语义覆盖状态，续页保持相同值。
    pub semantic: SemanticStatus,
    /// 至少一路达到召回预算；界面不得声称结果穷尽。
    pub limited: bool,
}

struct Session {
    id: String,
    fingerprint: String,
    revision: String,
    created: Instant,
    hits: Vec<HybridHit>,
    semantic: SemanticStatus,
    limited: bool,
}

/// 仅保存有界结果及摘要，不能钉住跨页数据库事务。
#[derive(Default)]
pub(crate) struct Sessions {
    entries: VecDeque<Session>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageCursor {
    session: String,
    offset: usize,
}

impl Sessions {
    /// 按 query 和正文 revision 校验 cursor 后返回续页；会话失效或条件改变时返回错误。
    pub fn page(
        &mut self,
        query: &HybridQuery,
        revision: &str,
        cursor: &str,
    ) -> Result<HybridPage, Error> {
        let cursor: PageCursor =
            serde_json::from_str(cursor).map_err(|_| invalid("融合搜索游标无效"))?;
        self.expire();
        let session = self
            .entries
            .iter()
            .find(|s| s.id == cursor.session)
            .ok_or_else(|| invalid("搜索结果已过期，请重新搜索"))?;
        if session.revision != revision {
            return Err(Error::SearchExpired);
        }
        if session.fingerprint != fingerprint(query)? {
            return Err(invalid("搜索条件已改变"));
        }
        if cursor.offset == 0 || cursor.offset >= session.hits.len() {
            return Err(invalid("融合搜索续页位置无效"));
        }
        page(session, cursor.offset, limit(query))
    }

    /// 冻结同版 hits、semantic 与候选窗口状态并返回首页；查询序列化失败时不发布会话。
    pub fn publish(
        &mut self,
        query: &HybridQuery,
        revision: &str,
        hits: Vec<HybridHit>,
        semantic: SemanticStatus,
        limited: bool,
    ) -> Result<HybridPage, Error> {
        self.expire();
        while self.entries.len() >= 4 {
            self.entries.pop_front();
        }
        let session = Session {
            // 身份不能在重新开库后归零复用，否则旧游标可能指向新的结果集合。
            id: uuid::Uuid::new_v4().to_string(),
            fingerprint: fingerprint(query)?,
            revision: revision.into(),
            created: Instant::now(),
            hits,
            semantic,
            limited,
        };
        let first = page(&session, 0, limit(query))?;
        self.entries.push_back(session);
        Ok(first)
    }

    fn expire(&mut self) {
        self.entries
            .retain(|s| s.created.elapsed() < Duration::from_mins(5));
    }
}

fn page(s: &Session, start: usize, count: usize) -> Result<HybridPage, Error> {
    let end = (start + count).min(s.hits.len());
    let next_cursor = (end < s.hits.len())
        .then(|| {
            serde_json::to_string(&PageCursor {
                session: s.id.clone(),
                offset: end,
            })
        })
        .transpose()
        .map_err(std::io::Error::other)?;
    Ok(HybridPage {
        hits: s.hits[start..end].to_vec(),
        next_cursor,
        semantic: s.semantic.clone(),
        limited: s.limited,
    })
}

fn limit(q: &HybridQuery) -> usize {
    if q.limit <= 0 {
        100
    } else {
        usize::try_from(q.limit.min(500)).unwrap_or(500)
    }
}
/// 将 q 的全文、筛选和页大小绑定到同一摘要；序列化错误原样传播。
pub(crate) fn fingerprint(q: &HybridQuery) -> Result<String, Error> {
    Ok(crate::vault::hex_digest(&Sha256::digest(
        serde_json::to_vec(q).map_err(std::io::Error::other)?,
    )))
}
fn invalid(text: &str) -> Error {
    Error::InvalidQuery {
        detail: text.into(),
    }
}

/// 校验 q 的文本预算及元数据筛选树；超限或混入全文表达式时返回 `InvalidQuery`。
pub(crate) fn validate(q: &HybridQuery) -> Result<(), Error> {
    fn walk(expr: &SearchExpr, depth: usize, budget: &mut usize) -> bool {
        if depth > 32 || *budget == 0 {
            return false;
        }
        *budget -= 1;
        match expr {
            SearchExpr::And(items) | SearchExpr::Or(items) => {
                items.iter().all(|v| walk(v, depth + 1, budget))
            }
            SearchExpr::Not(item) => walk(item, depth + 1, budget),
            SearchExpr::Tag(v) | SearchExpr::Path(v) | SearchExpr::File(v) => v.len() <= 4096,
            SearchExpr::Attr { key, value } => {
                key.len() <= 4096 && value.as_ref().is_none_or(|v| v.len() <= 4096)
            }
            _ => false,
        }
    }
    if q.text.trim().is_empty() || q.text.len() > 4096 {
        return Err(invalid("融合查询须为 1–4096 字节的非空文本"));
    }
    if !walk(&q.filter, 0, &mut 256) {
        return Err(invalid(
            "融合筛选只允许有限深度的标签、路径、文件名与属性条件",
        ));
    }
    Ok(())
}

/// 精确命中投影保留完整硬筛选；游标即使被篡改也不能越过筛选范围。
pub(crate) fn literal_query(q: &HybridQuery) -> SearchQuery {
    let terms = q
        .text
        .split_whitespace()
        .filter(|word| !lexical::is_query_stop_word(&crate::markdown::source_map::fold(word)))
        .take(64)
        .map(|word| SearchExpr::Term(word.to_owned()))
        .collect();
    SearchQuery {
        expr: SearchExpr::And(vec![q.filter.clone(), SearchExpr::Or(terms)]),
        limit: q.limit,
    }
}

/// 硬筛选先得到来源集合，再交给倒排和向量路线；完整条件在最终候选上再次验证。
/// conn 必须对应本次查询快照；条件编译、SQL、来源编号转换及取消错误均传播。
pub(crate) fn eligible(
    conn: &Connection,
    q: &HybridQuery,
    token: &SearchCancellation,
) -> Result<HashSet<u64>, Error> {
    let node = compile(&q.filter)?.unwrap_or(Node::And(vec![]));
    let context = DocContext::load(conn, &node, token)?;
    let mut stmt = conn.prepare("SELECT files.path, files.title, '', files.content_hash, NULL, search_sources.rowid FROM files JOIN search_sources ON files.path = search_sources.path")?;
    let mut rows = stmt.query([])?;
    let mut ids = HashSet::new();
    while let Some(row) = rows.next()? {
        token.check()?;
        let candidate = Candidate::read(row)?;
        if matches(&node, &candidate.doc(&context), None, token)? {
            ids.insert(u64::try_from(row.get::<_, i64>(5)?).map_err(std::io::Error::other)?);
        }
    }
    Ok(ids)
}

/// 向量召回只携带当前正文快照的来源 ID 与文本块边界。
#[derive(Clone)]
pub(crate) struct VectorHit {
    /// 当前正文快照中的来源行号。
    pub source: u64,
    /// 文本块起点，使用正文 UTF-8 字节偏移。
    pub start: usize,
    /// 文本块终点，不包含该字节。
    pub end: usize,
}

/// 向量路线显式报告候选窗口是否耗尽，不能把未搜索的尾部当作不存在。
#[derive(Default)]
pub(crate) struct VectorRecall {
    /// 经版本校验且通过硬筛选的文本块。
    pub hits: Vec<VectorHit>,
    /// 是否存在因候选预算而未枚举的尾部。
    pub limited: bool,
}

/// 文件名次融合，每条路线最多投一票；最终原文来自同一 `SQLite` 快照。
/// conn、index 和 eligible 必须同版；返回排名及窗口是否耗尽，索引、SQL 和取消错误传播。
pub(crate) fn retrieve(
    conn: &Connection,
    index: &SearchSnapshot,
    query: &HybridQuery,
    eligible: &HashSet<u64>,
    vectors: &[VectorHit],
    token: &SearchCancellation,
) -> Result<(Vec<HybridHit>, bool), Error> {
    let literal = literal_query(query);
    let words = lexical::query_terms(&query.text)
        .into_iter()
        .take(64)
        .collect::<Vec<_>>();
    let Recall {
        ranks,
        fuzzy_words,
        mut limited,
    } = recall(index, query, eligible, &words, vectors, token)?;
    let root = compile(&literal.expr)?.unwrap_or(Node::Or(vec![]));
    let context = DocContext::load(conn, &root, token)?;
    let cursor = Cursor {
        revision: index.revision.clone(),
        query: fingerprint(query)?,
        position: Position::Ranked(0),
    };
    let mut stmt = conn.prepare(&format!("SELECT {DOCUMENT_COLUMNS} FROM files JOIN search_sources ON files.path = search_sources.path WHERE search_sources.rowid = ?"))?;
    let aliases = crate::index::load_alias_keys(conn)?;
    let mut hits = Vec::new();
    for (
        id,
        Contribution {
            score,
            has_lexical,
            has_fuzzy,
        },
    ) in ranks
    {
        token.check()?;
        let candidate = stmt
            .query_row([i64::try_from(id).map_err(std::io::Error::other)?], |row| {
                Ok(Candidate::read(row))
            })??;
        let pin = crate::markdown::source_map::fold(&candidate.title)
            == crate::markdown::source_map::fold(query.text.trim())
            || aliases.get(&candidate.path).is_some_and(|keys| {
                keys.iter().any(|key| {
                    crate::markdown::source_map::fold(key)
                        == crate::markdown::source_map::fold(query.text.trim())
                })
            });
        let mut evidence = build_evidence(
            &candidate,
            has_lexical.then_some(words.as_slice()),
            has_fuzzy.then_some(fuzzy_words.as_slice()),
            vectors.iter().find(|v| v.source == id),
            token,
        )?;
        if has_fuzzy && !evidence.iter().any(|e| e.kind == EvidenceKind::Fuzzy) {
            let mut names = vec![candidate.title.as_str()];
            if let Some(keys) = aliases.get(&candidate.path) {
                names.extend(keys.iter().map(String::as_str));
            }
            for name in names {
                if let Some(range) = lexical::word_span(name, &fuzzy_words, token)? {
                    evidence.push(HybridEvidence {
                        kind: EvidenceKind::Fuzzy,
                        snippet: super::match_snippet(name, range),
                        location: None,
                    });
                    break;
                }
            }
        }
        let mut hit = occurrences::first(candidate, &root, &context, &cursor, token)?;

        if hit.matches.is_empty() {
            if let Some(item) = evidence.first() {
                hit.snippet.clone_from(&item.snippet);
            }
        }
        hits.push(RankedHit {
            exact_identity: pin,
            score,
            result: HybridHit { hit, evidence },
        });
    }
    hits.sort_by(|a, b| {
        b.exact_identity
            .cmp(&a.exact_identity)
            .then_with(|| b.score.total_cmp(&a.score))
            .then_with(|| a.result.hit.path.cmp(&b.result.hit.path))
    });
    limited |= hits.len() > 500;
    Ok((
        hits.into_iter()
            .take(500)
            .map(|ranked| ranked.result)
            .collect(),
        limited,
    ))
}

/// 证据只引用源文范围；近似词和语义段落不借用精确命中的统计契约。
fn build_evidence(
    candidate: &Candidate,
    words: Option<&[String]>,
    fuzzy_words: Option<&[String]>,
    vector: Option<&VectorHit>,
    token: &SearchCancellation,
) -> Result<Vec<HybridEvidence>, Error> {
    let mut evidence = Vec::new();
    if let Some(words) = fuzzy_words {
        if let Some(range) = lexical::word_span(&candidate.body, words, token)? {
            let rendered = occurrences::render(candidate, range);
            evidence.push(HybridEvidence {
                kind: EvidenceKind::Fuzzy,
                snippet: rendered.snippet,
                location: rendered.location,
            });
        }
    }
    if let Some(vector) = vector {
        let body = candidate
            .body
            .get(vector.start..vector.end)
            .ok_or_else(|| invalid("语义文本块与正文范围不一致"))?;
        let location = candidate
            .source_map
            .locate(vector.start..vector.end)
            .filter(|_| !body.is_empty())
            .and_then(|(start, end, line)| {
                Some(SearchLocation {
                    start_byte: i64::try_from(start).ok()?,
                    end_byte: i64::try_from(end).ok()?,
                    line: i64::try_from(line).ok()?,
                })
            });
        evidence.push(HybridEvidence {
            kind: EvidenceKind::Semantic,
            snippet: if body.is_empty() {
                candidate.title.clone()
            } else {
                body.chars().take(240).collect()
            },
            location,
        });
    }
    if let Some(words) = words {
        let mut found = None;
        for word in words {
            if let Some((start, end)) =
                super::find_folded(&candidate.body, &word.chars().collect::<Vec<_>>(), token)?
            {
                found = Some(occurrences::render(candidate, start..end));
                break;
            }
        }
        let item = found.unwrap_or_else(|| crate::SearchMatch {
            snippet: candidate.title.clone(),
            location: None,
        });
        evidence.insert(
            0,
            HybridEvidence {
                kind: EvidenceKind::Lexical,
                snippet: item.snippet,
                location: item.location,
            },
        );
    }
    Ok(evidence)
}

/// 每条路线最多贡献一个文件名次；布尔字段只控制相应证据的生成。
#[derive(Default)]
struct Contribution {
    score: f64,
    has_lexical: bool,
    has_fuzzy: bool,
}

/// 完整身份命中优先，其余文件按融合分数和稳定路径排序。
struct RankedHit {
    exact_identity: bool,
    score: f64,
    result: HybridHit,
}

/// 每篇文件的路线贡献与展开词一起返回，证据生成必须使用同一次召回的词项。
struct Recall {
    ranks: BTreeMap<u64, Contribution>,
    fuzzy_words: Vec<String>,
    limited: bool,
}

fn recall(
    index: &SearchSnapshot,
    query: &HybridQuery,
    eligible: &HashSet<u64>,
    words: &[String],
    vectors: &[VectorHit],
    token: &SearchCancellation,
) -> Result<Recall, Error> {
    let mut ranks: BTreeMap<u64, Contribution> = BTreeMap::new();
    let mut fuzzy_words = Vec::new();
    let mut limited = false;
    for (fuzzy, budget, weight) in [(false, 200, 1.0), (true, 100, 0.4)] {
        let filter = Box::new(SourceQuery::new(eligible.clone(), token.clone()));
        let (ranked, expanded) = index.lexical_query(words, fuzzy, Some(filter), token)?;
        let ids = ranked.page(0, budget)?;
        limited |= ids.len() == budget;
        for (rank, id) in ids.into_iter().enumerate() {
            let item = ranks
                .entry(u64::try_from(id).map_err(std::io::Error::other)?)
                .or_default();
            item.score +=
                weight / (61.0 + f64::from(u32::try_from(rank).map_err(std::io::Error::other)?));
            if fuzzy {
                item.has_fuzzy = true;
            } else {
                item.has_lexical = true;
            }
        }
        if fuzzy {
            fuzzy_words = expanded;
        }
    }
    let identities = index
        .identity_query(
            query.text.trim(),
            Box::new(SourceQuery::new(eligible.clone(), token.clone())),
            token,
        )
        .page(0, 501)?;
    limited |= identities.len() > 500;
    for id in identities {
        ranks
            .entry(u64::try_from(id).map_err(std::io::Error::other)?)
            .or_default()
            .has_lexical = true;
    }
    let mut seen = HashSet::new();
    for hit in vectors {
        if seen.insert(hit.source) {
            ranks.entry(hit.source).or_default().score +=
                1.0 / (60.0 + f64::from(u32::try_from(seen.len()).map_err(std::io::Error::other)?));
        }
    }
    limited |= seen.len() >= 200;
    Ok(Recall {
        ranks,
        fuzzy_words,
        limited,
    })
}
