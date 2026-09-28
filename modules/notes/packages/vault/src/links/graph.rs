//! 关系图谱：笔记之间的链接网络。
//!
//! 节点是 Markdown 笔记（附件不成节点），边是 `links` 表里已解析、且指向
//! 另一篇笔记的链接，同一对起止合并计数。指向自身的链接不成边，
//! 歧义链接没有确定目标，也不成边。死链可选地作为虚节点出现，
//! 以目标原文去掉 `#`/`?` 后缀为键，同一目标的不同锚点合成一个节点。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::Connection;

use crate::links::link::split_resource;
use crate::Error;

/// 图谱节点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphNode {
    /// 笔记的库内相对路径；死链节点为去掉锚点后的目标原文。
    pub path: String,
    /// 展示标题：笔记取文首一级标题或文件名词干，死链取目标的末段词干。
    pub title: String,
    /// 笔记的标签，升序；死链节点为空。
    pub tags: Vec<String>,
    /// 是否为尚未创建的死链目标。
    pub dead: bool,
}

/// 两篇笔记之间的有向边。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphEdge {
    /// 源笔记路径。
    pub from: String,
    /// 目标节点的 `path`。
    pub to: String,
    /// 这对起止之间的链接条数。
    pub count: u32,
}

/// 全库图谱；节点按 `path` 升序，边按 `(from, to)` 升序。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Graph {
    /// 全部节点。
    pub nodes: Vec<GraphNode>,
    /// 全部边。
    pub edges: Vec<GraphEdge>,
}

/// 文件名词干：去掉目录与最后一个扩展名。
fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    }
}

/// 从索引读出图谱。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_graph(conn: &Connection, include_dead: bool) -> Result<Graph, Error> {
    let mut markdown: BTreeMap<String, GraphNode> = BTreeMap::new();
    let mut stmt = conn.prepare("SELECT path, title FROM files WHERE kind = 'markdown'")?;
    for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))? {
        let (path, title) = row?;
        markdown.insert(
            path.clone(),
            GraphNode {
                path,
                title,
                tags: Vec::new(),
                dead: false,
            },
        );
    }
    let mut stmt = conn.prepare("SELECT path, tag FROM tags ORDER BY path, tag")?;
    for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))? {
        let (path, tag) = row?;
        if let Some(node) = markdown.get_mut(&path) {
            node.tags.push(tag);
        }
    }

    let mut counts: HashMap<(String, String), u32> = HashMap::new();
    let mut dead: BTreeSet<String> = BTreeSet::new();
    let mut stmt = conn.prepare("SELECT from_path, to_raw, to_path, resolution FROM links")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (from, raw, to_path, resolution) = row?;
        if !markdown.contains_key(&from) {
            continue;
        }
        let target = match (to_path, resolution.as_str()) {
            (Some(to), _) if markdown.contains_key(&to) => to,
            (None, "dead") if include_dead => {
                let key = split_resource(&raw).0.trim();
                if key.is_empty() {
                    continue;
                }
                let key = key.to_string();
                // 与真实笔记同名的目标不另立虚节点，避免两个节点共用一个 `path`。
                if !markdown.contains_key(&key) {
                    dead.insert(key.clone());
                }
                key
            }
            _ => continue,
        };
        if target != from {
            *counts.entry((from, target)).or_default() += 1;
        }
    }

    let mut nodes: Vec<GraphNode> = markdown.into_values().collect();
    nodes.extend(dead.into_iter().map(|path| GraphNode {
        title: stem(&path).to_string(),
        path,
        tags: Vec::new(),
        dead: true,
    }));
    nodes.sort_by(|left, right| left.path.cmp(&right.path));
    let mut edges: Vec<GraphEdge> = counts
        .into_iter()
        .map(|((from, to), count)| GraphEdge { from, to, count })
        .collect();
    edges.sort_by(|left, right| (&left.from, &left.to).cmp(&(&right.from, &right.to)));
    Ok(Graph { nodes, edges })
}
