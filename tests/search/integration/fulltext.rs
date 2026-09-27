//! 全文搜索端到端：trigram MATCH、短词 LIKE 回落、谓词组合与摘要。

use nous_core::{SearchExpr, SearchQuery, Vault, SNIPPET_END, SNIPPET_START};
use std::fs;
use tempfile::TempDir;

fn vault_with(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for (name, body) in files {
        let path = root.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("建目录");
        }
        fs::write(path, body).expect("写夹具");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn search(vault: &Vault, query: &SearchQuery) -> Vec<String> {
    vault
        .search(query)
        .expect("检索")
        .into_iter()
        .map(|hit| hit.path)
        .collect()
}

fn query(expr: SearchExpr) -> SearchQuery {
    SearchQuery { expr, limit: 0 }
}

fn all(exprs: Vec<SearchExpr>) -> SearchQuery {
    query(SearchExpr::And(exprs))
}

fn term(value: &str) -> SearchExpr {
    SearchExpr::Term(value.to_string())
}

fn terms(values: &[&str]) -> SearchQuery {
    all(values.iter().map(|value| term(value)).collect())
}

#[test]
fn term_search_is_case_insensitive_substring() {
    let (_root, _index, vault) = vault_with(&[
        ("alpha.md", "# Alpha Note\n\nThe Quick brown fox.\n"),
        ("beta.md", "unrelated content\n"),
    ]);
    let hits = vault.search(&terms(&["quick"])).expect("检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "alpha.md");
    assert_eq!(hits[0].title, "Alpha Note");
    // 摘要保留原文大小写并用控制字符圈出命中词。
    assert!(hits[0]
        .snippet
        .contains(&format!("{SNIPPET_START}Quick{SNIPPET_END}")));
}

#[test]
fn multiple_terms_are_anded() {
    let (_root, _index, vault) = vault_with(&[
        ("both.md", "alpha beta together\n"),
        ("one.md", "alpha only\n"),
    ]);
    assert_eq!(search(&vault, &terms(&["alpha", "beta"])), ["both.md"]);
}

#[test]
fn title_match_ranks_above_body_match() {
    let (_root, _index, vault) = vault_with(&[
        ("body.md", "# other title\n\nzebra appears in body only\n"),
        ("title.md", "# zebra heading\n\nnothing here\n"),
    ]);
    assert_eq!(search(&vault, &terms(&["zebra"])), ["title.md", "body.md"]);
}

#[test]
fn cjk_terms_match_via_trigram_and_like_fallback() {
    let (_root, _index, vault) = vault_with(&[
        ("cn.md", "# 笔记\n\n这是一段全文检索的测试正文。\n"),
        ("en.md", "unrelated english body\n"),
    ]);
    // 4 字走 trigram MATCH。
    assert_eq!(search(&vault, &terms(&["全文检索"])), ["cn.md"]);
    // 2 字走 LIKE 回落，结果一致。
    let hits = vault.search(&terms(&["检索"])).expect("检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "cn.md");
    assert!(hits[0]
        .snippet
        .contains(&format!("{SNIPPET_START}检索{SNIPPET_END}")));
    // 1 字同样可查（LIKE 回落的下限）。
    assert_eq!(search(&vault, &terms(&["笔"])), ["cn.md"]);
}

#[test]
fn short_ascii_term_falls_back_to_like() {
    let (_root, _index, vault) = vault_with(&[("fox.md", "The quick brown FOX.\n")]);
    // 子串 + 大小写不敏感。
    assert_eq!(search(&vault, &terms(&["ox"])), ["fox.md"]);
    assert_eq!(search(&vault, &terms(&["OX"])), ["fox.md"]);
}

#[test]
fn code_block_content_is_searchable_but_frontmatter_is_not() {
    let (_root, _index, vault) = vault_with(&[(
        "code.md",
        "---\nsecret: frontmatter-only-value\n---\n\n```rust\nfn fenced_token() {}\n```\n",
    )]);
    assert_eq!(search(&vault, &terms(&["fenced_token"])), ["code.md"]);
    assert!(search(&vault, &terms(&["frontmatter-only-value"])).is_empty());
}

#[test]
fn tag_and_attribute_predicates_combine_with_terms() {
    let (_root, _index, vault) = vault_with(&[
        (
            "a.md",
            "---\nstatus: Draft\n---\n\n# A\n\ntarget body #keep\n",
        ),
        ("b.md", "# B\n\ntarget body plain\n"),
    ]);
    let combined = vault
        .search(&all(vec![
            term("target"),
            SearchExpr::Tag("keep".to_string()),
        ]))
        .expect("检索");
    assert_eq!(combined.len(), 1);
    assert_eq!(combined[0].path, "a.md");
    // 属性值大小写不敏感精确匹配。
    let by_attribute = vault
        .search(&query(SearchExpr::Attr {
            key: "status".to_string(),
            value: Some("DRAFT".to_string()),
        }))
        .expect("检索");
    assert_eq!(by_attribute.len(), 1);
    assert_eq!(by_attribute[0].path, "a.md");
    // 谓词之间是 AND：不存在的组合无结果。
    let impossible = vault
        .search(&all(vec![
            SearchExpr::Tag("keep".to_string()),
            SearchExpr::Attr {
                key: "status".to_string(),
                value: Some("published".to_string()),
            },
        ]))
        .expect("检索");
    assert!(impossible.is_empty());
}

#[test]
fn path_predicate_filters_by_substring_with_wildcards_escaped() {
    let (_root, _index, vault) = vault_with(&[
        ("notes/one.md", "shared token inside\n"),
        ("other/two.md", "shared token inside\n"),
    ]);
    let filtered = vault
        .search(&all(vec![
            term("shared"),
            SearchExpr::Path("notes/".to_string()),
        ]))
        .expect("检索");
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].path, "notes/one.md");
    // LIKE 通配符按字面处理，不当作模式。
    let literal = vault
        .search(&all(vec![
            term("shared"),
            SearchExpr::Path("notes%".to_string()),
        ]))
        .expect("检索");
    assert!(literal.is_empty());
}

#[test]
fn predicate_only_query_lists_files_with_lead_snippet() {
    let (_root, _index, vault) =
        vault_with(&[("a.md", "# A\n\nbody text without the query.\n#keep\n")]);
    let hits = vault
        .search(&query(SearchExpr::Tag("keep".to_string())))
        .expect("检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "A");
    assert!(!hits[0].snippet.is_empty());
    assert!(!hits[0].snippet.contains(SNIPPET_START));
}

#[test]
fn empty_query_returns_nothing() {
    let (_root, _index, vault) = vault_with(&[("a.md", "body\n")]);
    assert!(vault
        .search(&SearchQuery::default())
        .expect("检索")
        .is_empty());
}

#[test]
fn non_markdown_files_are_not_searchable() {
    let (_root, _index, vault) = vault_with(&[("data.txt", "hello searchable world\n")]);
    assert!(search(&vault, &terms(&["searchable"])).is_empty());
}

#[test]
fn limit_caps_result_count() {
    let files: Vec<(String, String)> = (0..5)
        .map(|index| (format!("f{index}.md"), "common token body\n".to_string()))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(name, body)| (name.as_str(), body.as_str()))
        .collect();
    let (_root, _index, vault) = vault_with(&refs);
    let hits = vault
        .search(&SearchQuery {
            expr: term("common"),
            limit: 2,
        })
        .expect("检索");
    assert_eq!(hits.len(), 2);
}
