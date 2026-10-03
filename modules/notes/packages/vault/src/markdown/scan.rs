//! 从 Markdown 源一次解析抽出链接、标题、全文正文、标签与 frontmatter。
//!
//! 链接区间供改名事务按字节重写；标题与正文供索引（锚点解析、全文搜索）；
//! 标签与 frontmatter 属性供搜索谓词。所有派生事实共享同一次 `to_mdast`。

use markdown::mdast::Node;
use markdown::{to_mdast, Constructs, ParseOptions};
use regex::Regex;
use std::collections::HashSet;
use std::ops::Range;
use std::sync::OnceLock;

use crate::markdown::frontmatter;
use crate::links::link::{LinkKind, LinkRecord};
use crate::markdown::source_map::{SourceMap, TextKind};
use crate::markdown::tag;

fn wiki_regex() -> &'static Regex {
    static WIKI: OnceLock<Regex> = OnceLock::new();
    WIKI.get_or_init(|| Regex::new(r"\[\[([^\[\]\r\n]+)\]\]").expect("wiki 正则"))
}

/// 一篇标题记录：等级、纯文本与标题节点在源文件的字节区间。
///
/// 区间覆盖整个标题节点（含 `#` 标记行首），供锚点跳转定位块起点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeadingScan {
    /// ATX/Setext 等级，1–6。
    pub level: i64,
    /// 去除行内语法后的标题纯文本（已 trim）。
    pub text: String,
    /// 标题节点起点（含）。
    pub start_byte: i64,
    /// 标题节点终点（不含）。
    pub end_byte: i64,
}

/// 一篇 Markdown 的完整抽取结果。
pub(crate) struct ScannedMarkdown {
    /// 首个非空标题文本；展示标题回退用，与历史 `find_heading` 语义一致。
    pub title: Option<String>,
    /// 出链，按 `start_byte` 升序。
    pub links: Vec<LinkRecord>,
    /// 全部非空标题，按文档顺序。
    pub headings: Vec<HeadingScan>,
    /// 全文索引用正文纯文本：frontmatter、HTML、数学与链接 URL 除外，
    /// 代码块内容计入（对齐 Obsidian 的搜索范围）。
    pub body_text: String,
    /// 正文到原始源码的范围与章节边界，跟随正文在同一次解析中生成。
    pub source_map: SourceMap,
    /// frontmatter 与行内标签合并后的规范化标签（小写、无 `#`、去重）。
    pub tags: Vec<String>,
    /// frontmatter 属性行 `(key, value)`；key 保留原文大小写。
    pub attributes: Vec<(String, String)>,
}

impl ScannedMarkdown {
    fn empty() -> Self {
        Self {
            title: None,
            links: Vec::new(),
            headings: Vec::new(),
            body_text: String::new(),
            source_map: SourceMap::default(),
            tags: Vec::new(),
            attributes: Vec::new(),
        }
    }
}

/// 一次解析同时取出全部派生事实，避免同一篇走多遍 `to_mdast`。
///
/// 解析失败（非法 UTF-8 由调用方拦截；此处是 mdast 构造错误）返回空结果，
/// 不能挡住库打开。
#[must_use]
pub fn scan_markdown(from_path: &str, source: &str) -> ScannedMarkdown {
    scan_markdown_strict(from_path, source).unwrap_or_else(|_| ScannedMarkdown::empty())
}

/// 导出等内容事务使用严格解析；解析错误不能成为空文档或空身份表。
/// # Errors
/// Markdown 语法树无法构造时返回原始解析错误。
pub(crate) fn scan_markdown_strict(
    from_path: &str,
    source: &str,
) -> Result<ScannedMarkdown, markdown::message::Message> {
    let tree = parse_tree_strict(source)?;
    let mut links = Vec::new();
    let mut excluded = Vec::new();
    let mut references = HashSet::new();
    collect_references(&tree, &mut references);
    walk(
        &tree,
        from_path,
        source,
        &mut links,
        &mut excluded,
        &mut references,
    );
    excluded.sort_unstable_by_key(|span| span.start);
    collect_wiki(from_path, source, &excluded, &mut links);
    links.sort_by_key(|link| link.start_byte);

    let mut structure = Structure {
        source_map: SourceMap::new(source),
        ..Structure::default()
    };
    collect_structure(&tree, source, &mut structure);
    let wiki_ranges: Vec<Range<usize>> = links
        .iter()
        .filter(|link| link.kind == LinkKind::Wiki)
        .filter_map(|link| {
            let start = usize::try_from(link.start_byte).ok()?;
            let end = usize::try_from(link.end_byte).ok()?;
            Some(start..end)
        })
        .collect();
    let mut tags = Vec::new();
    let mut attributes = Vec::new();
    if let Some(yaml) = &structure.frontmatter {
        let data = frontmatter::parse(yaml);
        tags = data.tags;
        attributes = data.attributes;
    }
    for inline in tag::inline_tags(source, &structure.text_ranges, &wiki_ranges) {
        if !tags.contains(&inline) {
            tags.push(inline);
        }
    }
    let title = structure
        .headings
        .first()
        .map(|heading| heading.text.clone());
    Ok(ScannedMarkdown {
        title,
        links,
        headings: structure.headings,
        body_text: structure.body,
        source_map: structure.source_map,
        tags,
        attributes,
    })
}

/// 两条扫描路径必须使用相同语法树规则；索引的容错只保留在公开扫描入口。
fn parse_tree_strict(source: &str) -> Result<Node, markdown::message::Message> {
    let options = ParseOptions {
        constructs: Constructs {
            frontmatter: true,
            math_flow: true,
            math_text: true,
            ..Constructs::gfm()
        },
        ..ParseOptions::default()
    };
    to_mdast(source, &options)
}

/// 只建立导出所需的身份键，不生成全文索引、出链和源码映射。
/// # Errors
/// 严格语法树解析失败时传播错误；标题和别名语义与完整索引相同。
pub(crate) fn scan_identity_strict(source: &str) -> Result<Vec<String>, markdown::message::Message> {
    let tree = parse_tree_strict(source)?;
    let mut title = None;
    let mut yaml = None;
    collect_identity(&tree, &mut title, &mut yaml);
    let attributes = yaml
        .map(|source| frontmatter::parse(source).attributes)
        .unwrap_or_default();
    Ok(crate::links::identity::keys_from_metadata(
        title.as_deref(),
        &attributes,
    ))
}

fn collect_identity<'a>(node: &'a Node, title: &mut Option<String>, yaml: &mut Option<&'a str>) {
    match node {
        Node::Heading(heading) if title.is_none() => {
            *title = heading_record(heading).map(|record| record.text);
        }
        Node::Yaml(value) if yaml.is_none() => *yaml = Some(&value.value),
        _ => {}
    }
    if title.is_some() && yaml.is_some() {
        return;
    }
    if let Some(children) = node.children() {
        for child in children {
            collect_identity(child, title, yaml);
        }
    }
}

#[cfg(test)]
#[path = "../../../../../../test/notes/vault/unit/markdown/export_identity.rs"]
mod export_identity_tests;

/// 结构遍历的累积输出。
#[derive(Default)]
struct Structure {
    headings: Vec<HeadingScan>,
    body: String,
    source_map: SourceMap,
    frontmatter: Option<String>,
    /// `Text` 节点的源字节区间；行内标签按原文提取，实体转义不会被误解码。
    text_ranges: Vec<Range<usize>>,
}

/// 收集标题、正文纯文本、frontmatter 原文与 `Text` 源区间。
///
/// 块级子节点后补 `\n`、表格单元格后补空格，避免跨节点词粘连制造
/// 假 trigram 命中。
fn collect_structure(node: &Node, source: &str, out: &mut Structure) {
    match node {
        Node::Yaml(yaml) => {
            if out.frontmatter.is_none() {
                out.frontmatter = Some(yaml.value.clone());
            }
            return;
        }
        Node::Toml(_)
        | Node::Html(_)
        | Node::Math(_)
        | Node::InlineMath(_)
        | Node::Definition(_)
        | Node::Image(_)
        | Node::ImageReference(_) => return,
        Node::Code(code) => {
            append_search_text(node, &code.value, source, TextKind::Code, out);
            out.body.push('\n');
            return;
        }
        Node::InlineCode(code) => {
            let value = code.value.replace("\r\n", " ").replace(['\r', '\n'], " ");
            append_search_text(node, &value, source, TextKind::InlineCode, out);
            return;
        }
        Node::Text(text) => {
            append_search_text(node, &text.value, source, TextKind::Text, out);
            if let Some(position) = &text.position {
                let start = position.start.offset.min(source.len());
                let end = position.end.offset.min(source.len()).max(start);
                out.text_ranges.push(start..end);
            }
            return;
        }
        Node::Heading(heading) => {
            out.source_map.sections.push(out.body.len());
            if let Some(record) = heading_record(heading) {
                out.headings.push(record);
            }
        }
        Node::Break(_) | Node::ThematicBreak(_) => {
            out.body.push(' ');
            return;
        }
        _ => {}
    }
    if let Some(children) = node.children() {
        for child in children {
            collect_structure(child, source, out);
            match child {
                Node::TableCell(_) => out.body.push(' '),
                Node::Paragraph(_)
                | Node::Heading(_)
                | Node::Blockquote(_)
                | Node::List(_)
                | Node::ListItem(_)
                | Node::Table(_)
                | Node::TableRow(_) => out.body.push('\n'),
                _ => {}
            }
        }
    }
}

fn append_search_text(node: &Node, value: &str, source: &str, kind: TextKind, out: &mut Structure) {
    if let Some(position) = node.position() {
        out.source_map.append(
            &mut out.body,
            value,
            source,
            position.start.offset..position.end.offset,
            kind,
        );
    } else {
        out.body.push_str(value);
    }
}

fn heading_record(heading: &markdown::mdast::Heading) -> Option<HeadingScan> {
    let text = heading
        .children
        .iter()
        .map(Node::to_string)
        .collect::<String>();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let position = heading.position.as_ref()?;
    Some(HeadingScan {
        level: i64::from(heading.depth),
        text: trimmed.to_string(),
        start_byte: i64::try_from(position.start.offset).ok()?,
        end_byte: i64::try_from(position.end.offset).ok()?,
    })
}

fn collect_references(node: &Node, references: &mut HashSet<String>) {
    match node {
        Node::LinkReference(link) => {
            references.insert(link.identifier.to_lowercase());
        }
        Node::ImageReference(image) => {
            references.insert(image.identifier.to_lowercase());
        }
        _ => {}
    }
    if let Some(children) = node.children() {
        for child in children {
            collect_references(child, references);
        }
    }
}

fn walk(
    node: &Node,
    from_path: &str,
    source: &str,
    out: &mut Vec<LinkRecord>,
    excluded: &mut Vec<Range<usize>>,
    references: &mut HashSet<String>,
) {
    let target = match node {
        Node::Image(image) => Some(image.url.as_str()),
        // CommonMark 使用第一条同名定义；后续重复定义与未引用定义都不参与改名。
        Node::Definition(definition)
            if references.remove(&definition.identifier.to_lowercase()) =>
        {
            Some(definition.url.as_str())
        }
        _ => None,
    };
    if let Some(record) = target.and_then(|url| markdown_link(from_path, source, node, url)) {
        out.push(record);
    }
    if matches!(
        node,
        Node::Code(_)
            | Node::InlineCode(_)
            | Node::Math(_)
            | Node::InlineMath(_)
            | Node::Html(_)
            | Node::Yaml(_)
            | Node::Toml(_)
            | Node::Definition(_)
            | Node::Image(_)
            | Node::ImageReference(_)
    ) {
        if let Some(position) = node.position() {
            excluded.push(position.start.offset..position.end.offset);
        }
        return;
    }
    if let Node::Link(link) = node {
        if let Some(record) = markdown_link(from_path, source, node, &link.url) {
            out.push(record);
        }
        if let Some(position) = &link.position {
            // 标签内可以有 wiki，目标 URL 和标题中的双括号不能成为额外链接。
            if let (Some(first), Some(last)) = (
                link.children.first().and_then(Node::position),
                link.children.last().and_then(Node::position),
            ) {
                excluded.push(position.start.offset..first.start.offset);
                excluded.push(last.end.offset..position.end.offset);
            } else {
                excluded.push(position.start.offset..position.end.offset);
            }
        }
    }
    if let Some(children) = node.children() {
        for child in children {
            walk(child, from_path, source, out, excluded, references);
        }
    }
}

fn markdown_link(from_path: &str, source: &str, node: &Node, url: &str) -> Option<LinkRecord> {
    let url = url.trim();
    if url.is_empty() || is_external(url) || url.starts_with('#') {
        return None;
    }
    let position = node.position()?;
    let start = i64::try_from(point_offset_to_byte(source, position.start.offset)).ok()?;
    let end = i64::try_from(point_offset_to_byte(source, position.end.offset)).ok()?;
    Some(LinkRecord {
        from_path: from_path.to_string(),
        to_raw: url.to_string(),
        to_path: None,
        kind: LinkKind::Markdown,
        start_byte: start,
        end_byte: end,
        resolution: crate::links::link::LinkResolution::Dead,
    })
}

fn collect_wiki(
    from_path: &str,
    source: &str,
    excluded: &[Range<usize>],
    out: &mut Vec<LinkRecord>,
) {
    let wiki = wiki_regex();
    for cap in wiki.captures_iter(source) {
        let full = cap.get(0).expect("0");
        let preceding_escapes = source.as_bytes()[..full.start()]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        let excluded_index = excluded.partition_point(|span| span.end <= full.start());
        if preceding_escapes % 2 == 1
            || excluded
                .get(excluded_index)
                .is_some_and(|span| span.contains(&full.start()))
        {
            continue;
        }
        let inner = crate::markdown::wiki::decode_text(cap.get(1).expect("1").as_str());
        let target = inner
            .split_once('|')
            .map_or(inner.as_str(), |(t, _)| t)
            .trim();
        if target.is_empty() {
            continue;
        }
        // 只用原始 UTF-8 的区间；解码后的字符长度不能用来定位改名写入。
        let start = i64::try_from(full.start()).expect("start");
        let end = i64::try_from(full.end()).expect("end");
        out.push(LinkRecord {
            from_path: from_path.to_string(),
            to_raw: target.to_string(),
            to_path: None,
            kind: LinkKind::Wiki,
            start_byte: start,
            end_byte: end,
            resolution: crate::links::link::LinkResolution::Dead,
        });
    }
}

fn is_external(url: &str) -> bool {
    url.starts_with("//")
        || url.split_once(':').is_some_and(|(scheme, _)| {
            scheme
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
                && scheme
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'+' | b'-' | b'.'))
        })
}

/// markdown-rs 的 `Point.offset` 是源 UTF-8 字节下标，不是 Unicode 标量下标。
fn point_offset_to_byte(source: &str, offset: usize) -> usize {
    offset.min(source.len())
}
