//! 入链与未链接提及。
//!
//! 已链接来自索引；未链接在查询时扫 Markdown 正文，不入库。

use markdown::mdast::Node;
use markdown::{to_mdast, Constructs, ParseOptions};
use regex::{Regex, RegexBuilder};
use std::path::Path;

use crate::scan;

/// 提及是入链还是正文里尚未做成链接的出现。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MentionKind {
    /// `links.to_path` 指向当前文件。
    Linked,
    /// 正文出现了标题或文件名，但该区间不是链接。
    Unlinked,
}

impl MentionKind {
    /// NAPI / JSON 用的稳定字符串。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Linked => "linked",
            Self::Unlinked => "unlinked",
        }
    }
}

/// 一条已链接或未链接提及。
///
/// `start_byte`/`end_byte` 是源文件 UTF-8 字节区间；`snippet` 是该区间所在段落。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionRecord {
    /// 源文件库内相对路径。
    pub from_path: String,
    /// 源文件展示标题。
    pub from_title: String,
    /// 源文件内容修改时间（自纪元起的纳秒）。
    pub mtime: i64,
    /// 命中区间起点（含）。
    pub start_byte: i64,
    /// 命中区间终点（不含）。
    pub end_byte: i64,
    /// 命中所在段落，供界面展示上下文。
    pub snippet: String,
    /// 已链接或未链接。
    pub kind: MentionKind,
    /// 已链接时的语法；未链接为 `None`。
    pub link_kind: Option<crate::link::LinkKind>,
    /// 已链接为链接原文目标；未链接为命中文本。
    pub to_raw: String,
}

/// 指向一篇笔记的已链接提及与未链接提及。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mentions {
    /// 索引里 `to_path` 指向该笔记的链接。
    pub linked: Vec<MentionRecord>,
    /// 其它 Markdown 里出现标题/文件名、但不是链接的位置。
    pub unlinked: Vec<MentionRecord>,
}

/// 当前笔记用于未链接扫描的针。标题与文件名去重；短于两个字的丢掉。
#[must_use]
pub(crate) fn mention_needles(title: &str, path: &str) -> Vec<String> {
    let mut out = Vec::new();
    push_needle(&mut out, title);
    if let Some(stem) = Path::new(path).file_stem() {
        push_needle(&mut out, &stem.to_string_lossy());
    }
    out
}

fn push_needle(out: &mut Vec<String>, raw: &str) {
    let trimmed = raw.trim();
    if trimmed.chars().count() < 2 {
        return;
    }
    if out.iter().any(|existing| existing == trimmed) {
        return;
    }
    out.push(trimmed.to_string());
}

/// 取出覆盖 `[start, end)` 的段落（按空行切开）。
#[must_use]
pub(crate) fn paragraph_snippet(source: &str, start: usize, end: usize) -> String {
    let start = start.min(source.len());
    let end = end.min(source.len()).max(start);
    // 外部改写后索引偏移可能落进 UTF-8 字符内部；按字节找 ASCII 空行，
    // 最后只在空行边界切字符串，既保留上下文，也不让暂未刷新的索引中断阅读。
    let bytes = source.as_bytes();
    let para_start = bytes[..start]
        .windows(2)
        .rposition(|pair| pair == b"\n\n")
        .map_or(0, |index| index + 2);
    let para_end = bytes[end..]
        .windows(2)
        .position(|pair| pair == b"\n\n")
        .map_or(source.len(), |index| end + index);
    source[para_start..para_end].trim().to_string()
}

/// 在一篇源里找未链接针。代码、数学、任何链接区间都不计入。
#[must_use]
pub(crate) fn find_unlinked(
    from_path: &str,
    source: &str,
    needles: &[String],
) -> Vec<(usize, usize)> {
    if needles.is_empty() {
        return Vec::new();
    }
    let Ok(tree) = to_mdast(source, &mention_parse_options()) else {
        return Vec::new();
    };
    let links = scan::scan_markdown(from_path, source).links;
    let occupied: Vec<(usize, usize)> = links
        .iter()
        .filter_map(|link| {
            let start = usize::try_from(link.start_byte).ok()?;
            let end = usize::try_from(link.end_byte).ok()?;
            Some((start, end))
        })
        .collect();
    let regexes = compile_needles(needles);
    if regexes.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    walk_unlinked(&tree, source, &regexes, &occupied, &mut hits);
    dedupe_overlaps(hits)
}

/// 与编辑器一致：打开 `$` / `$$`，否则公式会落到 Text 里被当成未链接。
fn mention_parse_options() -> ParseOptions {
    ParseOptions {
        constructs: Constructs {
            math_flow: true,
            math_text: true,
            ..Constructs::default()
        },
        ..ParseOptions::default()
    }
}

fn compile_needles(needles: &[String]) -> Vec<Regex> {
    needles
        .iter()
        .filter_map(|needle| {
            RegexBuilder::new(&regex::escape(needle))
                .case_insensitive(true)
                .build()
                .ok()
        })
        .collect()
}

fn overlaps(left: (usize, usize), right: (usize, usize)) -> bool {
    left.0 < right.1 && right.0 < left.1
}

fn range_occupied(occupied: &[(usize, usize)], start: usize, end: usize) -> bool {
    occupied.iter().any(|&range| overlaps(range, (start, end)))
}

fn walk_unlinked(
    node: &Node,
    source: &str,
    regexes: &[Regex],
    occupied: &[(usize, usize)],
    hits: &mut Vec<(usize, usize)>,
) {
    match node {
        Node::Code(_)
        | Node::InlineCode(_)
        | Node::Math(_)
        | Node::InlineMath(_)
        | Node::Link(_)
        | Node::Image(_) => {}
        Node::Text(text) => collect_text_hits(source, text, regexes, occupied, hits),
        _ => {
            if let Some(children) = node.children() {
                for child in children {
                    walk_unlinked(child, source, regexes, occupied, hits);
                }
            }
        }
    }
}

fn collect_text_hits(
    source: &str,
    text: &markdown::mdast::Text,
    regexes: &[Regex],
    occupied: &[(usize, usize)],
    hits: &mut Vec<(usize, usize)>,
) {
    let Some(position) = text.position.as_ref() else {
        return;
    };
    let text_start = position.start.offset;
    let Some(raw) = source.get(text_start..position.end.offset) else {
        return;
    };
    let decoded = crate::wiki::decoded_ranges(raw);
    // 提及的区间会用于原文替换；mdast 的 value 已去掉引用前缀、转义与 CRLF，
    // 只能用 AST 限定正文范围，再在源字节上匹配，不能把解码后的位置相加。
    for regex in regexes {
        for found in regex.find_iter(raw) {
            let start = text_start + found.start();
            let end = text_start + found.end();
            if range_occupied(occupied, start, end)
                || decoded
                    .iter()
                    .any(|range| overlaps((range.start, range.end), (found.start(), found.end())))
            {
                continue;
            }
            hits.push((start, end));
        }
    }
}

fn dedupe_overlaps(mut hits: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    hits.sort_by(|left, right| {
        left.0.cmp(&right.0).then_with(|| {
            right
                .1
                .saturating_sub(right.0)
                .cmp(&left.1.saturating_sub(left.0))
        })
    });
    let mut out = Vec::new();
    for hit in hits {
        if out.iter().any(|&kept| overlaps(kept, hit)) {
            continue;
        }
        out.push(hit);
    }
    out
}
