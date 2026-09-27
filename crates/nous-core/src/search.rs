//! 全文搜索：检索表达式的求值与摘要截取。
//!
//! 查询串解析（`OR`、`-`、括号、`tag:`、`[属性]`、`/正则/`、`line:` 等）是上层职责；
//! 本模块只接受结构化表达式，用户输入一律进绑定参数，不拼进 SQL 文本。
//!
//! 执行分两步：
//!
//! 1. 候选规划保留 AND／OR 的交并关系；长词由排名索引召回（标题权重更高），
//!    短词、标签、属性和路径由 `SQLite` 筛选。没有可下推条件时扫描全部 Markdown。
//! 2. 候选逐篇按完整表达式求值：正则、`line:`（逐行）、`section:`（按标题切段）、
//!    `OR` 与取反都在这里完成。游标仅取最终结果所需候选，不全量装载正文。
//!
//! 全文词语义是「大小写不敏感的子串匹配」；标签、属性、路径与文件名是整篇级谓词，
//! 出现在 `line:`/`section:` 内部时仍按整篇判断。

mod evidence;
mod occurrences;
mod plan;

pub(crate) use occurrences::execute as execute_matches_page;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::ops::Range;

use regex::{Regex, RegexBuilder};
use rusqlite::Connection;

use crate::error::Error;
use crate::search_index::SearchSnapshot;
use crate::search_text::{fold, SourceMap};
use crate::SearchCancellation;
use plan::Plan;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 摘要里包住命中词的起始控制字符；界面按控制字符切分高亮，不会与正文冲突。
pub const SNIPPET_START: char = '\u{1}';
/// 摘要里包住命中词的结束控制字符。
pub const SNIPPET_END: char = '\u{2}';

/// 命中词两侧保留的上下文字符数。
const SNIPPET_CONTEXT: usize = 40;

/// 正则可能覆盖整篇正文，摘要只展示有限高亮文本，定位仍保留完整区间。
const SNIPPET_MATCH: usize = 120;

pub(super) const INITIAL_MATCHES: usize = 5;

/// 无全文词时摘要取正文开头的字符数。
const SNIPPET_LEAD: usize = 80;

/// 正则编译后的状态机上限；防止病态模式占满内存。
const REGEX_SIZE_LIMIT: usize = 1 << 20;

/// 正文只在成为候选后读取，避免排名和属性筛选把整个资料库载入内存。
const DOCUMENT_COLUMNS: &str =
    "files.path, files.title, search_sources.body, files.content_hash, search_sources.source_map";

/// 结构化检索表达式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum SearchExpr {
    /// 子条件全部满足；空列表表示没有条件。
    And(Vec<SearchExpr>),
    /// 任一子条件满足。
    Or(Vec<SearchExpr>),
    /// 子条件不满足。
    Not(Box<SearchExpr>),
    /// 全文词：标题或正文里大小写不敏感的子串。
    Term(String),
    /// 正则表达式，匹配标题或正文（在 `line:`/`section:` 内匹配该行或该段）。
    Regex(String),
    /// 标签；祖先标签前缀匹配嵌套子标签，`#` 前缀与大小写不敏感。
    Tag(String),
    /// frontmatter 属性；`value` 为 `None` 时只要求键存在。键值大小写不敏感精确匹配。
    Attr {
        /// 属性名。
        key: String,
        /// 属性值；`None` 表示任意值。
        value: Option<String>,
    },
    /// 库内路径子串，大小写敏感。
    Path(String),
    /// 文件名子串，大小写不敏感。
    File(String),
    /// 正文某一行满足子条件。
    Line(Box<SearchExpr>),
    /// 某个标题段（含标题行）满足子条件。
    Section(Box<SearchExpr>),
}

/// 一次检索：表达式与每页文件数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchQuery {
    /// 检索表达式；没有任何条件时返回空结果。
    pub expr: SearchExpr,
    /// 每页文件数；非正数按 100 处理，最大 500。
    pub limit: i64,
}

impl Default for SearchQuery {
    fn default() -> Self {
        Self {
            expr: SearchExpr::And(Vec::new()),
            limit: 0,
        }
    }
}

/// 一条搜索命中。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    /// 命中文件库内相对路径。
    pub path: String,
    /// 展示标题。
    pub title: String,
    /// 正文摘要；命中词以 [`SNIPPET_START`]/[`SNIPPET_END`] 包围，可能为空串。
    pub snippet: String,
    /// 索引对应文件的 SHA-256；定位前必须核对内容版本。
    pub content_hash: String,
    /// 首批正向正文命中，按正文顺序排列，最多 5 处。
    pub matches: Vec<SearchMatch>,
    /// 去重后的精确正文命中总数，纯谓词或仅标题命中为零。
    pub match_count: i64,
    /// 更多具体命中的游标，绑定查询、文件及索引版本；不能用已加载数量代替它。
    pub matches_cursor: Option<String>,
}

/// 一篇文件的后续具体命中；每次最多返回 20 处，不持有跨页读事务。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchMatchesPage {
    /// 按正文顺序排列的下一批位置与摘要。
    pub matches: Vec<SearchMatch>,
    /// 已经遍历完毕时为 `None`，有后续命中才提供游标。
    pub next_cursor: Option<String>,
}

/// 一处正文命中；纯谓词或仅标题命中不产生虚构的正文位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchMatch {
    /// 原文范围；解析器无法证明对应关系时为空，调用方须提示无法定位。
    pub location: Option<SearchLocation>,
    /// 该处命中的正文上下文，沿用摘要高亮标记。
    pub snippet: String,
}

/// 源文件同一内容版本内的 UTF-8 字节区间与一基行号。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchLocation {
    /// 起点（含），不能直接当作 JavaScript 下标。
    pub start_byte: i64,
    /// 终点（不含）。
    pub end_byte: i64,
    /// 源码行号，从 1 开始。
    pub line: i64,
}

/// 规范化并编译后的表达式；空条件已被剔除，正则已编译。
enum Node {
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    Term(String),
    Regex(Regex),
    Tag(String),
    Attr { key: String, value: Option<String> },
    Path(String),
    File(String),
    Line(Box<Node>),
    Section(Box<Node>),
}

/// 规范化表达式；没有实际条件的分支返回 `None`。
fn compile(expr: &SearchExpr) -> Result<Option<Node>, Error> {
    let group = |children: &[SearchExpr]| -> Result<Vec<Node>, Error> {
        let mut out = Vec::new();
        for child in children {
            if let Some(node) = compile(child)? {
                out.push(node);
            }
        }
        Ok(out)
    };
    let text = |value: &str| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };
    Ok(match expr {
        SearchExpr::And(children) => {
            let mut nodes = group(children)?;
            match nodes.len() {
                0 => None,
                1 => nodes.pop(),
                _ => Some(Node::And(nodes)),
            }
        }
        SearchExpr::Or(children) => {
            let mut nodes = group(children)?;
            match nodes.len() {
                0 => None,
                1 => nodes.pop(),
                _ => Some(Node::Or(nodes)),
            }
        }
        SearchExpr::Not(child) => compile(child)?.map(|node| Node::Not(Box::new(node))),
        SearchExpr::Term(value) => text(value).map(Node::Term),
        SearchExpr::Regex(pattern) => {
            if pattern.is_empty() {
                None
            } else {
                let regex = RegexBuilder::new(pattern)
                    .size_limit(REGEX_SIZE_LIMIT)
                    .dfa_size_limit(REGEX_SIZE_LIMIT)
                    .build()
                    .map_err(|error| Error::InvalidQuery {
                        detail: format!("正则表达式无效：{error}"),
                    })?;
                Some(Node::Regex(regex))
            }
        }
        SearchExpr::Tag(value) => {
            let tag = value.trim().trim_start_matches('#').trim().to_lowercase();
            (!tag.is_empty()).then_some(Node::Tag(tag))
        }
        SearchExpr::Attr { key, value } => text(key).map(|key| Node::Attr {
            key: fold(&key),
            value: value.as_deref().and_then(text).map(|value| fold(&value)),
        }),
        SearchExpr::Path(value) => text(value).map(Node::Path),
        SearchExpr::File(value) => text(value).map(|value| Node::File(value.to_lowercase())),
        SearchExpr::Line(child) => compile(child)?.map(|node| Node::Line(Box::new(node))),
        SearchExpr::Section(child) => compile(child)?.map(|node| Node::Section(Box::new(node))),
    })
}

impl Node {
    fn visit(&self, found: &mut impl FnMut(&Node)) {
        found(self);
        match self {
            Self::And(children) | Self::Or(children) => {
                for child in children {
                    child.visit(found);
                }
            }
            Self::Not(child) | Self::Line(child) | Self::Section(child) => child.visit(found),
            _ => {}
        }
    }

    fn uses(&self, test: impl Fn(&Node) -> bool) -> bool {
        let mut hit = false;
        self.visit(&mut |node| hit = hit || test(node));
        hit
    }
}

/// 一页真实命中；只有找到下一篇匹配文件时才提供续页游标，不推测总数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPage {
    /// 本页结果，顺序与同版本完整查询一致。
    pub hits: Vec<SearchHit>,
    /// 绑定查询及来源版本的内部游标；调用方仅原样传回，不解析或修改。
    pub next_cursor: Option<String>,
}

/// 续页位置记录已消费候选，不能用最终结果数量代替排名偏移。
#[derive(Clone, Serialize, Deserialize)]
enum Position {
    Ranked(usize),
    Path(String),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    revision: String,
    query: String,
    position: Position,
}

/// 查询身份同时约束文件页与命中页，避免游标在不同表达式之间复用。
fn fingerprint(query: &SearchQuery) -> Result<String, Error> {
    Ok(
        Sha256::digest(serde_json::to_vec(query).map_err(std::io::Error::other)?)
            .iter()
            .fold(String::with_capacity(64), |mut text, byte| {
                let _ = write!(text, "{byte:02x}");
                text
            }),
    )
}

/// 执行一个同版本页面；无条件返回空页，取消、过期游标及查询错误分别向上传播。
pub(crate) fn execute_page(
    conn: &Connection,
    index: &SearchSnapshot,
    query: &SearchQuery,
    cursor: Option<&str>,
    cancellation: &SearchCancellation,
) -> Result<SearchPage, Error> {
    cancellation.check()?;
    let fingerprint = fingerprint(query)?;
    let Some(root) = compile(&query.expr)? else {
        if cursor.is_some() {
            return Err(Error::InvalidQuery {
                detail: "搜索条件已改变，请重新搜索".into(),
            });
        }
        return Ok(SearchPage {
            hits: Vec::new(),
            next_cursor: None,
        });
    };
    let plan = Plan::of(&root);
    let cursor = if let Some(text) = cursor {
        let cursor: Cursor = serde_json::from_str(text).map_err(|_| Error::InvalidQuery {
            detail: "搜索续页游标无效".into(),
        })?;
        if cursor.query != fingerprint {
            return Err(Error::InvalidQuery {
                detail: "搜索条件已改变，请重新搜索".into(),
            });
        }
        if cursor.revision != index.revision {
            return Err(Error::SearchExpired);
        }
        match &cursor.position {
            Position::Ranked(offset)
                if plan.is_ranked() && (*offset as u64) <= index.documents() => {}
            Position::Path(_) if !plan.is_ranked() => {}
            _ => {
                return Err(Error::InvalidQuery {
                    detail: "搜索续页位置无效".into(),
                })
            }
        }
        cursor
    } else {
        Cursor {
            revision: index.revision.clone(),
            query: fingerprint,
            position: if plan.is_ranked() {
                Position::Ranked(0)
            } else {
                Position::Path(String::new())
            },
        }
    };
    let context = DocContext::load(conn, &root, cancellation)?;
    let mut page = PageSearch {
        conn,
        root: &root,
        context: &context,
        cancellation,
        cursor,
        limit: usize::try_from(if query.limit <= 0 {
            100
        } else {
            query.limit.min(500)
        })
        .unwrap_or(100),
        hits: Vec::new(),
        next_cursor: None,
    };
    if plan.is_ranked() {
        page.ranked(index, &plan)?;
    } else {
        page.scan(&plan)?;
    }
    cancellation.check()?;
    Ok(SearchPage {
        hits: page.hits,
        next_cursor: page.next_cursor,
    })
}

/// 页内执行状态只活到该页结束；续页不持有数据库事务，避免钉住 WAL。
struct PageSearch<'a> {
    conn: &'a Connection,
    root: &'a Node,
    context: &'a DocContext,
    cancellation: &'a SearchCancellation,
    cursor: Cursor,
    limit: usize,
    hits: Vec<SearchHit>,
    next_cursor: Option<String>,
}

impl PageSearch<'_> {
    /// 多检查一篇真命中证明还有下一页；游标停在该篇之前，重试同游标得到相同页面。
    fn accept(&mut self, candidate: Candidate, next: Position) -> Result<bool, Error> {
        self.cancellation.check()?;
        if matches(
            self.root,
            &candidate.doc(self.context),
            None,
            self.cancellation,
        )? {
            if self.hits.len() == self.limit {
                self.next_cursor =
                    Some(serde_json::to_string(&self.cursor).map_err(std::io::Error::other)?);
                return Ok(false);
            }
            self.hits.push(occurrences::first(
                candidate,
                self.root,
                self.context,
                &self.cursor,
                self.cancellation,
            )?);
        }
        self.cursor.position = next;
        Ok(true)
    }

    fn scan(&mut self, plan: &Plan) -> Result<(), Error> {
        let Position::Path(after) = &self.cursor.position else {
            unreachable!()
        };
        let (sql, mut params) = plan.sql(DOCUMENT_COLUMNS);
        params.push(Box::new(after.clone()));
        let mut statement = self
            .conn
            .prepare(&format!("{sql} AND files.path > ? ORDER BY files.path"))?;
        let mut rows = statement.query(rusqlite::params_from_iter(
            params.iter().map(std::convert::AsRef::as_ref),
        ))?;
        while let Some(row) = rows.next()? {
            let candidate = Candidate::read(row)?;
            let next = Position::Path(candidate.path.clone());
            if !self.accept(candidate, next)? {
                break;
            }
        }
        Ok(())
    }

    fn ranked(&mut self, index: &SearchSnapshot, plan: &Plan) -> Result<(), Error> {
        let ranked = plan.ranked(self.conn, index, self.cancellation)?;
        let mut statement = self.conn.prepare(&format!(
            "SELECT {DOCUMENT_COLUMNS} FROM search_sources JOIN files ON files.path = search_sources.path WHERE search_sources.rowid = ?1"
        ))?;
        let Position::Ranked(mut offset) = self.cursor.position else {
            unreachable!()
        };
        let mut batch = (self.limit + 1).max(32);
        loop {
            let sources = ranked.page(offset, batch)?;
            let exhausted = sources.len() < batch;
            for source in sources {
                self.cancellation.check()?;
                offset += 1;
                let candidate = statement.query_row([source], |row| {
                    // 来源缺失表示快照契约被破坏，不能当成正常的无结果吞掉。
                    Ok(Candidate::read(row))
                })??;
                if !self.accept(candidate, Position::Ranked(offset))? {
                    return Ok(());
                }
            }
            if exhausted {
                break;
            }
            // 残余条件可能排除整页，增长批次继续召回，但不为超出库规模的候选分配堆。
            batch = batch.saturating_mul(2).min(
                usize::try_from(index.documents())
                    .unwrap_or(usize::MAX)
                    .max(1),
            );
        }
        Ok(())
    }
}

/// SQL 候选的一行。
struct Candidate {
    path: String,
    title: String,
    body: String,
    content_hash: String,
    source_map: SourceMap,
}

impl Candidate {
    fn doc<'a>(&'a self, context: &'a DocContext) -> Doc<'a> {
        Doc {
            path: &self.path,
            title: &self.title,
            body: &self.body,
            tags: context.tags.get(&self.path).map_or(&[], Vec::as_slice),
            attrs: context.attrs.get(&self.path).map_or(&[], Vec::as_slice),
            source_map: &self.source_map,
        }
    }

    fn read(row: &rusqlite::Row<'_>) -> Result<Self, Error> {
        let map: Option<String> = row.get(4)?;
        Ok(Self {
            path: row.get(0)?,
            title: row.get(1)?,
            body: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            content_hash: row.get(3)?,
            source_map: map
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(std::io::Error::other)?
                .unwrap_or_default(),
        })
    }
}

/// 整篇级谓词求值所需的派生数据；只加载表达式实际用到的表。
#[derive(Default)]
struct DocContext {
    tags: HashMap<String, Vec<String>>,
    attrs: HashMap<String, Vec<(String, String)>>,
}

impl DocContext {
    fn load(
        conn: &Connection,
        root: &Node,
        cancellation: &SearchCancellation,
    ) -> Result<Self, Error> {
        let mut context = Self::default();
        if root.uses(|node| matches!(node, Node::Tag(_))) {
            for (path, tag) in pairs(conn, "SELECT path, tag FROM tags")? {
                cancellation.check()?;
                context.tags.entry(path).or_default().push(tag);
            }
        }
        if root.uses(|node| matches!(node, Node::Attr { .. })) {
            let mut stmt = conn.prepare("SELECT path, key, value FROM attributes")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                cancellation.check()?;
                let (path, key, value) = row?;
                context
                    .attrs
                    .entry(path)
                    .or_default()
                    .push((fold(&key), fold(&value)));
            }
        }
        Ok(context)
    }
}

fn pairs(conn: &Connection, sql: &str) -> Result<Vec<(String, String)>, Error> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 求值中的一篇文档。
struct Doc<'a> {
    path: &'a str,
    title: &'a str,
    body: &'a str,
    tags: &'a [String],
    attrs: &'a [(String, String)],
    source_map: &'a SourceMap,
}

/// 按表达式判定文档；`scope` 为 `None` 时文字条件作用于整篇（标题与正文）。
fn matches(
    node: &Node,
    doc: &Doc<'_>,
    scope: Option<&Range<usize>>,
    cancellation: &SearchCancellation,
) -> Result<bool, Error> {
    cancellation.check()?;
    Ok(match node {
        Node::And(children) | Node::Or(children) => {
            let all = matches!(node, Node::And(_));
            for child in children {
                if matches(child, doc, scope, cancellation)? != all {
                    return Ok(!all);
                }
            }
            all
        }
        Node::Not(child) => !matches(child, doc, scope, cancellation)?,
        Node::Term(term) => match scope {
            Some(range) => find_ci(&doc.body[range.clone()], term, cancellation)?.is_some(),
            None => {
                find_ci(doc.body, term, cancellation)?.is_some()
                    || find_ci(doc.title, term, cancellation)?.is_some()
            }
        },
        Node::Regex(regex) => match scope {
            Some(range) => regex.is_match(&doc.body[range.clone()]),
            None => regex.is_match(doc.body) || regex.is_match(doc.title),
        },
        Node::Tag(tag) => doc.tags.iter().any(|item| {
            item == tag
                || item
                    .strip_prefix(tag.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        }),
        Node::Attr { key, value } => doc.attrs.iter().any(|(item_key, item_value)| {
            item_key == key && value.as_ref().is_none_or(|value| item_value == value)
        }),
        Node::Path(path) => doc.path.contains(path.as_str()),
        Node::File(name) => doc
            .path
            .rsplit('/')
            .next()
            .unwrap_or(doc.path)
            .to_lowercase()
            .contains(name.as_str()),
        Node::Line(child) | Node::Section(child) => {
            for range in scopes(node, doc, scope) {
                if matches(child, doc, Some(&range), cancellation)? {
                    return Ok(true);
                }
            }
            false
        }
    })
}

/// 范围条件始终落在父范围内；按需产生范围，避免逐行查询先分配整篇行数组。
fn scopes<'a>(
    node: &Node,
    doc: &'a Doc<'a>,
    parent: Option<&Range<usize>>,
) -> Box<dyn Iterator<Item = Range<usize>> + 'a> {
    let parent = parent.cloned().unwrap_or(0..doc.body.len());
    if matches!(node, Node::Line(_)) {
        let mut start = parent.start;
        return Box::new(doc.body[parent].split_inclusive('\n').map(move |line| {
            let range = start..start + line.trim_end_matches(['\r', '\n']).len();
            start += line.len();
            range
        }));
    }
    let mut start = 0;
    Box::new(
        doc.source_map
            .sections
            .iter()
            .copied()
            .chain(std::iter::once(doc.body.len()))
            .filter_map(move |end| {
                let range = start.max(parent.start)..end.min(parent.end);
                start = end;
                (range.start < range.end).then_some(range)
            }),
    )
}

/// 每处命中独立截取上下文；范围来自表达式证据，不能重新寻找同名词。
fn match_snippet(body: &str, range: Range<usize>) -> String {
    let start = range.start;
    let end = range.end;
    let window_start = body[..start]
        .char_indices()
        .rev()
        .nth(SNIPPET_CONTEXT - 1)
        .map_or(0, |(index, _)| index);
    let window_end = body[end..]
        .char_indices()
        .nth(SNIPPET_CONTEXT)
        .map_or(body.len(), |(index, _)| end + index);
    let prefix = if window_start > 0 { "…" } else { "" };
    let suffix = if window_end < body.len() { "…" } else { "" };
    let highlight_end = body[start..end]
        .char_indices()
        .nth(SNIPPET_MATCH)
        .map_or(end, |(offset, _)| start + offset);
    let truncated = if highlight_end < end { "…" } else { "" };
    format!(
        "{prefix}{}{SNIPPET_START}{}{truncated}{SNIPPET_END}{}{suffix}",
        body[window_start..start].trim_start(),
        &body[start..highlight_end],
        body[end..window_end].trim_end(),
    )
}

/// 取正文开头作摘要（谓词查询没有命中词可圈）。
fn lead_snippet(body: &str) -> String {
    let text = body.trim();
    if text.chars().count() <= SNIPPET_LEAD {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .nth(SNIPPET_LEAD)
        .map_or(text.len(), |(index, _)| index);
    format!("{}…", &text[..cut])
}

/// 大小写不敏感子串查找（Unicode 逐字符折叠）；返回原文字节区间。
///
/// 保持逐字符折叠的源码边界语义；长文本比较定期检查取消，不返回部分匹配。
fn find_ci(
    haystack: &str,
    needle: &str,
    cancellation: &SearchCancellation,
) -> Result<Option<(usize, usize)>, Error> {
    let needle_chars: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    find_folded(haystack, &needle_chars, cancellation)
}

/// 同一命中流复用已折叠词，避免为每一处命中重新分配查询字符。
fn find_folded(
    haystack: &str,
    needle_chars: &[char],
    cancellation: &SearchCancellation,
) -> Result<Option<(usize, usize)>, Error> {
    cancellation.check()?;
    if needle_chars.is_empty() {
        return Ok(None);
    }
    for (step, (start, _)) in haystack.char_indices().enumerate() {
        if step % 256 == 0 {
            cancellation.check()?;
        }
        let mut matched = 0;
        for (compared, (offset, ch)) in haystack[start..].char_indices().enumerate() {
            if compared > 0 && compared % 1024 == 0 {
                cancellation.check()?;
            }
            let mut mismatch = false;
            for folded in ch.to_lowercase() {
                if needle_chars.get(matched) != Some(&folded) {
                    mismatch = true;
                    break;
                }
                matched += 1;
            }
            if mismatch {
                break;
            }
            if matched == needle_chars.len() {
                return Ok(Some((start, start + offset + ch.len_utf8())));
            }
        }
    }
    Ok(None)
}
