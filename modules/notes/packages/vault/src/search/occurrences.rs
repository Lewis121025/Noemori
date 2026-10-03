//! 单篇命中分页：首屏精确计数但只生成五处摘要，续页按相同证据流验证位置。

use std::ops::Range;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    compile, evidence, fingerprint, lead_snippet, match_snippet, Candidate, Cursor, DocContext,
    Node, SearchHit, SearchLocation, SearchMatch, SearchMatchesPage, SearchQuery, DOCUMENT_COLUMNS,
    INITIAL_MATCHES,
};
use crate::{index::fulltext::SearchSnapshot, Error, SearchCancellation};

const PAGE_SIZE: usize = 20;

/// 正文区间是稳定的续页位置；不能使用源码位置，因为有些合法证据无法映射回源码。
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MatchCursor {
    revision: String,
    query: String,
    path: String,
    content_hash: String,
    after: Range<usize>,
}

/// 首屏仍给出精确总数；内存仅保存前五处位置，其余只计数，不创建摘要与源码映射。
pub(super) fn first(
    candidate: Candidate,
    root: &Node,
    context: &DocContext,
    version: &Cursor,
    cancellation: &SearchCancellation,
) -> Result<SearchHit, Error> {
    let doc = candidate.doc(context);
    let mut ranges = Vec::new();
    let mut count = 0_i64;
    for range in evidence::occurrences(root, &doc, cancellation)? {
        let range = range?;
        count += 1;
        if ranges.len() < INITIAL_MATCHES {
            ranges.push(range);
        }
    }
    cancellation.check()?;
    let matches_cursor = if count > i64::try_from(INITIAL_MATCHES).unwrap_or(i64::MAX) {
        Some(encode(&MatchCursor {
            revision: version.revision.clone(),
            query: version.query.clone(),
            path: candidate.path.clone(),
            content_hash: candidate.content_hash.clone(),
            after: ranges.last().expect("存在更多命中时首批非空").clone(),
        })?)
    } else {
        None
    };
    let matches = ranges
        .into_iter()
        .map(|range| render(&candidate, range))
        .collect::<Vec<_>>();
    Ok(SearchHit {
        snippet: matches.first().map_or_else(
            || lead_snippet(&candidate.body),
            |item| item.snippet.clone(),
        ),
        path: candidate.path,
        title: candidate.title,
        content_hash: candidate.content_hash,
        matches,
        match_count: count,
        matches_cursor,
    })
}

/// 续页绑定整个索引版本；任何库变化都要求重新搜索，不把两个版本的计数和位置混用。
pub(crate) fn execute(
    conn: &Connection,
    index: &SearchSnapshot,
    query: &SearchQuery,
    cursor: &str,
    cancellation: &SearchCancellation,
) -> Result<SearchMatchesPage, Error> {
    execute_with_identity(
        conn,
        index,
        query,
        &fingerprint(query)?,
        cursor,
        cancellation,
    )
}

/// 表达式负责定位，完整请求身份负责游标归属；融合筛选不能在字面投影时丢失。
pub(crate) fn execute_with_identity(
    conn: &Connection,
    index: &SearchSnapshot,
    query: &SearchQuery,
    identity: &str,
    cursor: &str,
    cancellation: &SearchCancellation,
) -> Result<SearchMatchesPage, Error> {
    cancellation.check()?;
    let mut cursor: MatchCursor = serde_json::from_str(cursor).map_err(|_| invalid_cursor())?;
    if cursor.query != identity {
        return Err(invalid_cursor());
    }
    if cursor.revision != index.revision {
        return Err(Error::SearchExpired);
    }
    let root = compile(&query.expr)?.ok_or_else(invalid_cursor)?;
    let candidate = conn.query_row(
        &format!("SELECT {DOCUMENT_COLUMNS} FROM search_sources JOIN files ON files.path = search_sources.path WHERE files.path = ?1"),
        [&cursor.path],
        |row| Ok(Candidate::read(row)),
    ).optional()?.ok_or_else(invalid_cursor)??;
    if candidate.content_hash != cursor.content_hash {
        return Err(Error::SearchExpired);
    }
    let context = DocContext::load(conn, &root, cancellation)?;
    let doc = candidate.doc(&context);
    let mut found_after = false;
    let mut ranges = Vec::new();
    let mut more = false;
    for range in evidence::occurrences(&root, &doc, cancellation)? {
        let range = range?;
        if !found_after {
            found_after = range == cursor.after;
            continue;
        }
        if ranges.len() == PAGE_SIZE {
            more = true;
            break;
        }
        ranges.push(range);
    }
    if !found_after || ranges.is_empty() {
        return Err(invalid_cursor());
    }
    cancellation.check()?;
    let next_cursor = if more {
        cursor.after = ranges.last().expect("命中续页非空").clone();
        Some(encode(&cursor)?)
    } else {
        None
    };
    Ok(SearchMatchesPage {
        matches: ranges
            .into_iter()
            .map(|range| render(&candidate, range))
            .collect(),
        next_cursor,
    })
}

pub(super) fn render(candidate: &Candidate, range: Range<usize>) -> SearchMatch {
    let location = candidate
        .source_map
        .locate(range.clone())
        .and_then(|(start, end, line)| {
            Some(SearchLocation {
                start_byte: i64::try_from(start).ok()?,
                end_byte: i64::try_from(end).ok()?,
                line: i64::try_from(line).ok()?,
            })
        });
    SearchMatch {
        location,
        snippet: match_snippet(&candidate.body, range),
    }
}

fn encode(cursor: &MatchCursor) -> Result<String, Error> {
    Ok(serde_json::to_string(cursor).map_err(std::io::Error::other)?)
}

fn invalid_cursor() -> Error {
    Error::InvalidQuery {
        detail: "搜索命中续页游标无效，请重新搜索".into(),
    }
}
