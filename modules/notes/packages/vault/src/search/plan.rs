//! 将完整表达式投影为候选集合：只允许扩大召回，不能把范围条件当成整篇条件取反。

use std::collections::HashSet;

use rusqlite::{types::ToSql, Connection};
use tantivy::query::{BooleanQuery, Occur, Query};

use super::Node;
use crate::{
    index::fulltext::{RankedQuery, SearchSnapshot, SourceQuery},
    markdown::source_map::{fold, short_token},
    Error, SearchCancellation,
};

/// 候选集合的交并表达式；`All` 表示无法安全缩小范围，最终真值始终由正文求值决定。
pub(super) enum Plan {
    All,
    And(Vec<Self>),
    Or(Vec<Self>),
    Term(String),
    Tag(String),
    Attr { key: String, value: Option<String> },
    Path(String),
}

impl Plan {
    /// 保留每个 OR 分支的必要条件；未知分支使并集放宽为全集，不能直接丢弃。
    pub fn of(node: &Node) -> Self {
        match node {
            Node::And(children) | Node::Or(children) => {
                let all = matches!(node, Node::And(_));
                let mut plans = Vec::new();
                for child in children {
                    match Self::of(child) {
                        Self::All if !all => return Self::All,
                        Self::All => {}
                        plan => plans.push(plan),
                    }
                }
                match plans.len() {
                    0 => Self::All,
                    1 => plans.remove(0),
                    _ if all => Self::And(plans),
                    _ => Self::Or(plans),
                }
            }
            Node::Line(child) | Node::Section(child) => Self::of(child),
            Node::Term(term) => Self::Term(fold(term)),
            Node::Tag(tag) => Self::Tag(tag.clone()),
            Node::Attr { key, value } => Self::Attr {
                key: key.clone(),
                value: value.clone(),
            },
            Node::Path(path) => Self::Path(path.clone()),
            Node::Not(_) | Node::Regex(_) | Node::File(_) => Self::All,
        }
    }

    /// 含长词时使用全局相关度排序；仅短词与元数据时沿用 SQL 路径顺序。
    pub fn is_ranked(&self) -> bool {
        match self {
            Self::Term(term) => term.chars().count() >= 3,
            Self::And(children) | Self::Or(children) => children.iter().any(Self::is_ranked),
            _ => false,
        }
    }

    /// 只读取候选来源行号，将短词和元数据作为所属布尔分支内的无分数筛选器。
    /// SQL 或索引读取失败、取消时返回错误，不返回部分来源集合。
    pub fn ranked(
        &self,
        conn: &Connection,
        index: &SearchSnapshot,
        cancellation: &SearchCancellation,
    ) -> Result<RankedQuery, Error> {
        Ok(index.ranked(self.query(conn, index, cancellation)?, cancellation))
    }

    fn query(
        &self,
        conn: &Connection,
        index: &SearchSnapshot,
        cancellation: &SearchCancellation,
    ) -> Result<Box<dyn Query>, Error> {
        cancellation.check()?;
        if !self.is_ranked() {
            let (sql, params) = self.sql("search_sources.rowid");
            let mut statement = conn.prepare(&sql)?;
            let rows = statement.query_map(
                rusqlite::params_from_iter(params.iter().map(std::convert::AsRef::as_ref)),
                |row| row.get::<_, i64>(0),
            )?;
            let mut sources = HashSet::new();
            for row in rows {
                cancellation.check()?;
                sources.insert(u64::try_from(row?).map_err(std::io::Error::other)?);
            }
            return Ok(Box::new(SourceQuery::new(sources, cancellation.clone())));
        }
        match self {
            Self::Term(term) => Ok(index.term_query(term)),
            Self::And(children) | Self::Or(children) => {
                let occur = if matches!(self, Self::And(_)) {
                    Occur::Must
                } else {
                    Occur::Should
                };
                let clauses = children
                    .iter()
                    .map(|child| Ok((occur, child.query(conn, index, cancellation)?)))
                    .collect::<Result<_, Error>>()?;
                Ok(Box::new(BooleanQuery::new(clauses)))
            }
            _ => unreachable!("不含长词的子树已通过 SQL 求值"),
        }
    }

    /// 仅不含长词的子树可下推 SQL；列名由内部调用方固定，用户文本全部绑定。
    pub fn sql(&self, columns: &str) -> (String, Vec<Box<dyn ToSql>>) {
        let mut params = Vec::new();
        let predicate = self.predicate(&mut params);
        (
            format!(
                "SELECT {columns} FROM files LEFT JOIN search_sources ON search_sources.path = files.path
                 WHERE files.kind = 'markdown' AND ({predicate})"
            ),
            params,
        )
    }

    fn predicate(&self, params: &mut Vec<Box<dyn ToSql>>) -> String {
        if let Some(query) = self.short_query() {
            params.push(Box::new(query));
            // 从 FTS 命中反查主键，避免 LEFT JOIN 后逐篇判断来源 rowid，尤其是零结果查询。
            return "files.path IN (SELECT ss.path FROM search_short JOIN search_sources ss ON ss.rowid = search_short.rowid WHERE search_short MATCH ?)".into();
        }
        match self {
            Self::All => "1".into(),
            Self::And(children) | Self::Or(children) => {
                let join = if matches!(self, Self::And(_)) {
                    " AND "
                } else {
                    " OR "
                };
                let clauses = children
                    .iter()
                    .map(|child| child.predicate(params))
                    .collect::<Vec<_>>();
                format!("({})", clauses.join(join))
            }
            Self::Term(_) => unreachable!("长词不下推 SQL，短词已编译为 FTS 条件"),
            Self::Tag(tag) => {
                params.push(Box::new(tag.clone()));
                params.push(Box::new(format!("{}/%", escape_like(tag))));
                "EXISTS (SELECT 1 FROM tags WHERE tags.path = files.path AND (tags.tag = ? OR tags.tag LIKE ? ESCAPE '\\'))".into()
            }
            Self::Attr { key, value } => {
                params.push(Box::new(key.clone()));
                let value_filter = if let Some(value) = value {
                    params.push(Box::new(value.clone()));
                    " AND noemori_fold(attributes.value) = ?"
                } else {
                    ""
                };
                format!("EXISTS (SELECT 1 FROM attributes WHERE attributes.path = files.path AND noemori_fold(attributes.key) = ?{value_filter})")
            }
            Self::Path(path) => {
                params.push(Box::new(path.clone()));
                "instr(files.path, ?) > 0".into()
            }
        }
    }

    /// 纯短词子树保留交并关系并合成一次倒排查询；编码后的 token 不含 FTS 操作符。
    fn short_query(&self) -> Option<String> {
        match self {
            Self::Term(term) if term.chars().count() < 3 => Some(short_token(term)),
            Self::And(children) | Self::Or(children) => {
                let clauses = children
                    .iter()
                    .map(Self::short_query)
                    .collect::<Option<Vec<_>>>()?;
                let join = if matches!(self, Self::And(_)) {
                    " AND "
                } else {
                    " OR "
                };
                Some(format!("({})", clauses.join(join)))
            }
            _ => None,
        }
    }
}

/// 标签里的通配符是普通字符，祖先标签后追加的 `/` 才定义层级前缀。
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
