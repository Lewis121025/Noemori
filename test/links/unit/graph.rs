//! 关系图谱查询：节点是 Markdown 笔记，边是已解析链接按起止聚合的计数。

use std::fs;

use nous_vault::{GraphEdge, Vault};
use tempfile::TempDir;

fn vault_with(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for (name, body) in files {
        let path = root.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("目录");
        }
        fs::write(path, body).expect("写夹具");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn edge(from: &str, to: &str, count: u32) -> GraphEdge {
    GraphEdge {
        from: from.to_string(),
        to: to.to_string(),
        count,
    }
}

#[test]
fn nodes_are_markdown_notes_with_title_and_tags_and_edges_aggregate_links() {
    let (_root, _index, vault) = vault_with(&[
        (
            "a.md",
            "# 甲\n\n#项目 [[b]] 与 [[b#小节]]，再见 [b](b.md)。[[a#自身]] [[#锚点]]\n",
        ),
        ("b.md", "---\ntags: [阅读]\n---\n回到 [[a]]\n"),
        ("c.md", "孤立笔记\n"),
        ("img/pic.png", "png"),
        ("d.md", "![图](img/pic.png)\n"),
    ]);
    let graph = vault.graph(false).expect("图谱");
    let nodes: Vec<_> = graph
        .nodes
        .iter()
        .map(|node| {
            (
                node.path.as_str(),
                node.title.as_str(),
                node.tags.clone(),
                node.dead,
            )
        })
        .collect();
    assert_eq!(
        nodes,
        vec![
            ("a.md", "甲", vec!["项目".to_string()], false),
            ("b.md", "b", vec!["阅读".to_string()], false),
            ("c.md", "c", vec![], false),
            ("d.md", "d", vec![], false),
        ],
        "只含 Markdown 笔记，附件不成节点；路径升序"
    );
    // 同一对笔记的多条链接合并计数；指向自身的锚点与纯锚点不成边，附件链接不成边。
    assert_eq!(
        graph.edges,
        vec![edge("a.md", "b.md", 3), edge("b.md", "a.md", 1)]
    );
}

#[test]
fn dead_targets_become_optional_nodes_keyed_by_target_without_anchor() {
    let (_root, _index, vault) = vault_with(&[
        ("a.md", "[[未写#小节]] [[未写]] [缺](missing.md)\n"),
        ("b.md", "[[未写]]\n"),
    ]);
    assert!(vault.graph(false).expect("图谱").edges.is_empty());
    let graph = vault.graph(true).expect("含死链图谱");
    let dead: Vec<_> = graph
        .nodes
        .iter()
        .filter(|node| node.dead)
        .map(|node| (node.path.as_str(), node.title.as_str()))
        .collect();
    assert_eq!(dead, vec![("missing.md", "missing"), ("未写", "未写")]);
    assert_eq!(
        graph.edges,
        vec![
            edge("a.md", "missing.md", 1),
            edge("a.md", "未写", 2),
            edge("b.md", "未写", 1),
        ]
    );
}

#[test]
fn graph_follows_incremental_index_updates() {
    let (root, _index, vault) = vault_with(&[("a.md", "[[b]]\n"), ("b.md", "")]);
    assert_eq!(
        vault.graph(false).expect("图谱").edges,
        vec![edge("a.md", "b.md", 1)]
    );
    fs::write(root.path().join("a.md"), "不再链接\n").expect("改写");
    vault.refresh_index().expect("增量刷新");
    assert!(vault.graph(false).expect("图谱").edges.is_empty());
}
