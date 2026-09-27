//! 全文搜索：检索表达式的求值与摘要截取。
//!
//! 查询串解析（`OR`、`-`、括号、`tag:`、`[属性]`、`/正则/`、`line:` 等）是上层职责；
//! 本模块只接受结构化表达式，用户输入一律进绑定参数，不拼进 SQL 文本。
//!
//! 执行分两步：
//!
//! 1. 顶层 AND 里能下推的正向条件（全文词、标签、属性、路径）先用 SQL 取候选集：
//!    全部词 ≥3 字符走 FTS5 trigram `MATCH` 并按 `bm25` 排序（标题权重更高），
//!    否则回落 `LIKE` 扫描并按路径排序；没有可下推条件时候选是全部 Markdown。
//! 2. 候选逐篇按完整表达式求值：正则、`line:`（逐行）、`section:`（按标题切段）、
//!    `OR` 与取反都在这里完成。个人库规模下全量求值可以接受。
//!
//! 全文词语义是「大小写不敏感的子串匹配」；标签、属性、路径与文件名是整篇级谓词，
//! 出现在 `line:`/`section:` 内部时仍按整篇判断。

use std::collections::HashMap;

use regex::{Regex, RegexBuilder};
use rusqlite::types::ToSql;
use rusqlite::Connection;

use crate::error::Error;

/// 摘要里包住命中词的起始控制字符；界面按控制字符切分高亮，不会与正文冲突。
pub const SNIPPET_START: char = '\u{1}';
/// 摘要里包住命中词的结束控制字符。
pub const SNIPPET_END: char = '\u{2}';

/// 命中词两侧保留的上下文字符数。
const SNIPPET_CONTEXT: usize = 40;

/// 无全文词时摘要取正文开头的字符数。
const SNIPPET_LEAD: usize = 80;

/// 正则编译后的状态机上限；防止病态模式占满内存。
const REGEX_SIZE_LIMIT: usize = 1 << 20;

/// 结构化检索表达式。
#[derive(Debug, Clone, PartialEq, Eq)]
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

/// 一次检索：表达式与结果上限。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQuery {
    /// 检索表达式；没有任何条件时返回空结果。
    pub expr: SearchExpr,
    /// 结果上限；非正数按 100 处理，最大 500。
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
            key: key.to_lowercase(),
            value: value
                .as_deref()
                .and_then(text)
                .map(|value| value.to_lowercase()),
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

/// 执行结构化检索。
///
/// 没有任何条件时返回空结果——搜索必须由用户输入驱动，不做「列出全部」。
///
/// # Errors
///
/// 正则无效或 `SQLite` 查询失败。
pub(crate) fn execute(conn: &Connection, query: &SearchQuery) -> Result<Vec<SearchHit>, Error> {
    let Some(root) = compile(&query.expr)? else {
        return Ok(Vec::new());
    };
    let limit = usize::try_from(if query.limit <= 0 {
        100
    } else {
        query.limit.min(500)
    })
    .unwrap_or(100);
    let prefilter = Prefilter::of(&root);
    let candidates = prefilter.candidates(conn, (prefilter.complete).then_some(limit))?;
    let context = DocContext::load(conn, &root)?;
    let empty_tags: Vec<String> = Vec::new();
    let empty_attrs: Vec<(String, String)> = Vec::new();
    let empty_headings: Vec<String> = Vec::new();
    let mut hits = Vec::new();
    for candidate in candidates {
        if hits.len() >= limit {
            break;
        }
        let doc = Doc {
            path: &candidate.path,
            title: &candidate.title,
            body: &candidate.body,
            tags: context.tags.get(&candidate.path).unwrap_or(&empty_tags),
            attrs: context.attrs.get(&candidate.path).unwrap_or(&empty_attrs),
            headings: context
                .headings
                .get(&candidate.path)
                .unwrap_or(&empty_headings),
        };
        if matches(&root, &doc, None) {
            hits.push(SearchHit {
                snippet: snippet(&candidate.body, &root),
                path: candidate.path,
                title: candidate.title,
            });
        }
    }
    Ok(hits)
}

/// 下推到 SQL 的正向条件；`complete` 表示整个表达式都已下推，SQL 结果无需再筛。
struct Prefilter {
    terms: Vec<String>,
    tags: Vec<String>,
    attributes: Vec<(String, Option<String>)>,
    paths: Vec<String>,
    complete: bool,
}

impl Prefilter {
    fn of(root: &Node) -> Self {
        let mut out = Self {
            terms: Vec::new(),
            tags: Vec::new(),
            attributes: Vec::new(),
            paths: Vec::new(),
            complete: true,
        };
        let children = match root {
            Node::And(children) => children.iter().collect::<Vec<_>>(),
            other => vec![other],
        };
        for child in children {
            match child {
                Node::Term(term) => out.terms.push(term.clone()),
                Node::Tag(tag) => out.tags.push(tag.clone()),
                Node::Attr { key, value } => out.attributes.push((key.clone(), value.clone())),
                Node::Path(path) => out.paths.push(path.clone()),
                _ => out.complete = false,
            }
        }
        out
    }

    /// 取候选：有词时按相关度或路径排序；`limit` 只在表达式完全下推时使用。
    fn candidates(&self, conn: &Connection, limit: Option<usize>) -> Result<Vec<Candidate>, Error> {
        let mut filters = String::new();
        let mut params: Vec<Box<dyn ToSql>> = Vec::new();
        let limit_clause = limit.map_or(String::new(), |limit| format!(" LIMIT {limit}"));
        let sql =
            if !self.terms.is_empty() && self.terms.iter().all(|term| term.chars().count() >= 3) {
                let expression = self
                    .terms
                    .iter()
                    .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                params.push(Box::new(expression));
                self.push_filters(&mut filters, &mut params);
                format!(
                    "SELECT files.path, files.title, search_index.body
                 FROM search_index JOIN files ON files.path = search_index.path
                 WHERE search_index MATCH ?1 AND files.kind = 'markdown'{filters}
                 ORDER BY bm25(search_index, 0.0, 5.0, 1.0){limit_clause}"
                )
            } else {
                for term in &self.terms {
                    let pattern = format!("%{}%", escape_like(term));
                    filters.push_str(" AND (search_index.body LIKE ? ESCAPE '\\'");
                    filters.push_str(" OR search_index.title LIKE ? ESCAPE '\\')");
                    params.push(Box::new(pattern.clone()));
                    params.push(Box::new(pattern));
                }
                self.push_filters(&mut filters, &mut params);
                format!(
                    "SELECT files.path, files.title, search_index.body
                 FROM files LEFT JOIN search_index ON search_index.path = files.path
                 WHERE files.kind = 'markdown'{filters}
                 ORDER BY files.path{limit_clause}"
                )
            };
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(params.iter().map(std::convert::AsRef::as_ref)),
            |row| {
                Ok(Candidate {
                    path: row.get(0)?,
                    title: row.get(1)?,
                    body: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                })
            },
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 追加标签/属性/路径谓词；表别名唯一，多个同类谓词可以共存。
    fn push_filters(&self, filters: &mut String, params: &mut Vec<Box<dyn ToSql>>) {
        use std::fmt::Write as _;
        for (index, tag) in self.tags.iter().enumerate() {
            let _ = write!(
                filters,
                " AND EXISTS (SELECT 1 FROM tags tg{index}
                              WHERE tg{index}.path = files.path
                                AND (tg{index}.tag = ? OR tg{index}.tag LIKE ? ESCAPE '\\'))"
            );
            params.push(Box::new(tag.clone()));
            params.push(Box::new(format!("{}/%", escape_like(tag))));
        }
        for (index, (key, value)) in self.attributes.iter().enumerate() {
            let _ = write!(
                filters,
                " AND EXISTS (SELECT 1 FROM attributes at{index}
                              WHERE at{index}.path = files.path
                                AND lower(at{index}.key) = lower(?)"
            );
            params.push(Box::new(key.clone()));
            if let Some(value) = value {
                let _ = write!(filters, " AND lower(at{index}.value) = lower(?)");
                params.push(Box::new(value.clone()));
            }
            filters.push(')');
        }
        for path in &self.paths {
            filters.push_str(" AND files.path LIKE ? ESCAPE '\\'");
            params.push(Box::new(format!("%{}%", escape_like(path))));
        }
    }
}

/// SQL 候选的一行。
struct Candidate {
    path: String,
    title: String,
    body: String,
}

/// 整篇级谓词求值所需的派生数据；只加载表达式实际用到的表。
#[derive(Default)]
struct DocContext {
    tags: HashMap<String, Vec<String>>,
    attrs: HashMap<String, Vec<(String, String)>>,
    headings: HashMap<String, Vec<String>>,
}

impl DocContext {
    fn load(conn: &Connection, root: &Node) -> Result<Self, Error> {
        let mut context = Self::default();
        if root.uses(|node| matches!(node, Node::Tag(_))) {
            for (path, tag) in pairs(conn, "SELECT path, tag FROM tags")? {
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
                let (path, key, value) = row?;
                context
                    .attrs
                    .entry(path)
                    .or_default()
                    .push((key.to_lowercase(), value.to_lowercase()));
            }
        }
        if root.uses(|node| matches!(node, Node::Section(_))) {
            for (path, text) in pairs(conn, "SELECT path, text FROM headings ORDER BY path, idx")? {
                context.headings.entry(path).or_default().push(text);
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
    headings: &'a [String],
}

/// 按表达式判定文档；`scope` 为 `None` 时文字条件作用于整篇（标题与正文）。
fn matches(node: &Node, doc: &Doc<'_>, scope: Option<&str>) -> bool {
    match node {
        Node::And(children) => children.iter().all(|child| matches(child, doc, scope)),
        Node::Or(children) => children.iter().any(|child| matches(child, doc, scope)),
        Node::Not(child) => !matches(child, doc, scope),
        Node::Term(term) => match scope {
            Some(text) => find_ci(text, term).is_some(),
            None => find_ci(doc.body, term).is_some() || find_ci(doc.title, term).is_some(),
        },
        Node::Regex(regex) => match scope {
            Some(text) => regex.is_match(text),
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
        Node::Line(child) => doc.body.lines().any(|line| matches(child, doc, Some(line))),
        Node::Section(child) => sections(doc)
            .iter()
            .any(|section| matches(child, doc, Some(section))),
    }
}

/// 按标题切段：正文里标题是独立一行，按索引里的标题顺序依次对齐；首个标题前的内容自成一段。
fn sections(doc: &Doc<'_>) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut next = 0;
    for line in doc.body.lines() {
        if doc
            .headings
            .get(next)
            .is_some_and(|heading| heading.trim() == line.trim())
        {
            next += 1;
            out.push(String::new());
        }
        if let Some(current) = out.last_mut() {
            current.push_str(line);
            current.push('\n');
        }
    }
    out
}

/// 摘要：圈出第一处正向全文词或正则命中，两侧按字符数留上下文；没有可圈内容时取正文开头。
fn snippet(body: &str, root: &Node) -> String {
    let mut first: Option<(usize, usize)> = None;
    collect_positive(root, false, &mut |node| {
        let hit = match node {
            Node::Term(term) => find_ci(body, term),
            Node::Regex(regex) => regex
                .find(body)
                .filter(|found| !found.is_empty())
                .map(|found| (found.start(), found.end())),
            _ => None,
        };
        if let Some(hit) = hit {
            if first.is_none_or(|current| hit.0 < current.0) {
                first = Some(hit);
            }
        }
    });
    let Some((start, end)) = first else {
        return lead_snippet(body);
    };
    let window_start = body[..start]
        .char_indices()
        .rev()
        .nth(SNIPPET_CONTEXT)
        .map_or(0, |(index, _)| index);
    let window_end = body[end..]
        .char_indices()
        .nth(SNIPPET_CONTEXT)
        .map_or(body.len(), |(index, _)| end + index);
    let prefix = if window_start > 0 { "…" } else { "" };
    let suffix = if window_end < body.len() { "…" } else { "" };
    format!(
        "{prefix}{}{SNIPPET_START}{}{SNIPPET_END}{}{suffix}",
        body[window_start..start].trim_start(),
        &body[start..end],
        body[end..window_end].trim_end(),
    )
}

/// 遍历不在取反之下的叶子；取反条件的命中词不应被圈出。
fn collect_positive(node: &Node, negated: bool, found: &mut impl FnMut(&Node)) {
    match node {
        Node::And(children) | Node::Or(children) => {
            for child in children {
                collect_positive(child, negated, found);
            }
        }
        Node::Not(child) => collect_positive(child, !negated, found),
        Node::Line(child) | Node::Section(child) => collect_positive(child, negated, found),
        leaf if !negated => found(leaf),
        _ => {}
    }
}

/// 转义 LIKE 通配符；调用方统一 `ESCAPE '\'`。
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
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
/// 朴素逐位比较，最坏 O(n·m)；每篇正文命中即返回，个人库规模下无需更复杂的算法。
fn find_ci(haystack: &str, needle: &str) -> Option<(usize, usize)> {
    let needle_chars: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    if needle_chars.is_empty() {
        return None;
    }
    for (start, _) in haystack.char_indices() {
        let mut matched = 0;
        for (offset, ch) in haystack[start..].char_indices() {
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
                return Some((start, start + offset + ch.len_utf8()));
            }
        }
    }
    None
}
