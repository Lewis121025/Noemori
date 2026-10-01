//! 检索表达式：OR、取反、正则、文件名、属性存在、line: 与 section: 的组合语义。

use noemori_vault::{Error, SearchExpr, SearchQuery, Vault, SNIPPET_END, SNIPPET_START};
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

fn paths(vault: &Vault, expr: SearchExpr) -> Vec<String> {
    let mut out: Vec<String> = vault
        .search(&SearchQuery { expr, limit: 0 })
        .expect("检索")
        .into_iter()
        .map(|hit| hit.path)
        .collect();
    out.sort();
    out
}

fn term(value: &str) -> SearchExpr {
    SearchExpr::Term(value.to_string())
}

fn fixture() -> (TempDir, TempDir, Vault) {
    vault_with(&[
        (
            "apple.md",
            "---\nstatus: draft\n---\n\n# 水果\n\napple and banana\n\n## 价格\n\ncheap price\n",
        ),
        ("banana.md", "# 另一篇\n\nbanana only #fruit\n"),
        (
            "notes/cherry.md",
            "# 樱桃\n\ncherry line one\nsecond line apple\n",
        ),
    ])
}

#[test]
fn or_and_negation_compose() {
    let (_root, _index, vault) = fixture();
    assert_eq!(
        paths(&vault, SearchExpr::Or(vec![term("cherry"), term("banana")])),
        ["apple.md", "banana.md", "notes/cherry.md"],
    );
    assert_eq!(
        paths(
            &vault,
            SearchExpr::And(vec![
                term("banana"),
                SearchExpr::Not(Box::new(term("apple")))
            ]),
        ),
        ["banana.md"],
    );
    // 顶层取反对全库求值。
    assert_eq!(
        paths(&vault, SearchExpr::Not(Box::new(term("banana")))),
        ["notes/cherry.md"],
    );
}

#[test]
fn regex_matches_body_and_invalid_pattern_is_an_error() {
    let (_root, _index, vault) = fixture();
    assert_eq!(
        paths(&vault, SearchExpr::Regex(r"che+rry\s+line".to_string())),
        ["notes/cherry.md"],
    );
    let error = vault
        .search(&SearchQuery {
            expr: SearchExpr::Regex("(unclosed".to_string()),
            limit: 0,
        })
        .expect_err("无效正则");
    assert!(matches!(error, Error::InvalidQuery { .. }));
}

#[test]
fn line_requires_terms_on_the_same_line() {
    let (_root, _index, vault) = fixture();
    let same_line = SearchExpr::Line(Box::new(SearchExpr::And(vec![
        term("cherry"),
        term("apple"),
    ])));
    assert!(paths(&vault, same_line).is_empty());
    let second = SearchExpr::Line(Box::new(SearchExpr::And(vec![
        term("second"),
        term("apple"),
    ])));
    assert_eq!(paths(&vault, second), ["notes/cherry.md"]);
}

#[test]
fn section_scopes_to_heading_blocks() {
    let (_root, _index, vault) = fixture();
    // 「价格」段只有 cheap price；apple 在上一段。
    let split = SearchExpr::Section(Box::new(SearchExpr::And(vec![term("价格"), term("apple")])));
    assert!(paths(&vault, split).is_empty());
    let together =
        SearchExpr::Section(Box::new(SearchExpr::And(vec![term("价格"), term("cheap")])));
    assert_eq!(paths(&vault, together), ["apple.md"]);
}

#[test]
fn file_and_attribute_existence_predicates() {
    let (_root, _index, vault) = fixture();
    assert_eq!(
        paths(&vault, SearchExpr::File("CHER".to_string())),
        ["notes/cherry.md"]
    );
    // 文件名谓词不看目录部分。
    assert!(paths(&vault, SearchExpr::File("notes".to_string())).is_empty());
    assert_eq!(
        paths(
            &vault,
            SearchExpr::Attr {
                key: "Status".to_string(),
                value: None,
            },
        ),
        ["apple.md"],
    );
    assert_eq!(
        paths(
            &vault,
            SearchExpr::Or(vec![
                SearchExpr::Tag("fruit".to_string()),
                SearchExpr::Path("notes/".to_string()),
            ]),
        ),
        ["banana.md", "notes/cherry.md"],
    );
}

#[test]
fn snippet_marks_first_positive_match_not_negated_terms() {
    let (_root, _index, vault) = fixture();
    let hits = vault
        .search(&SearchQuery {
            expr: SearchExpr::And(vec![
                SearchExpr::Not(Box::new(term("zzz"))),
                SearchExpr::Regex("ban+ana".to_string()),
            ]),
            limit: 0,
        })
        .expect("检索");
    let banana = hits
        .iter()
        .find(|hit| hit.path == "banana.md")
        .expect("命中");
    assert!(banana
        .snippet
        .contains(&format!("{SNIPPET_START}banana{SNIPPET_END}")));
}

#[test]
fn empty_branches_are_ignored_and_all_empty_returns_nothing() {
    let (_root, _index, vault) = fixture();
    assert!(paths(
        &vault,
        SearchExpr::Or(vec![term("  "), SearchExpr::And(vec![])])
    )
    .is_empty());
    assert_eq!(
        paths(&vault, SearchExpr::And(vec![term(""), term("cherry")])),
        ["notes/cherry.md"],
    );
}

#[test]
fn snippet_comes_from_the_line_that_satisfies_the_whole_condition() {
    let (_root, _index, vault) =
        vault_with(&[("budget.md", "预算还在讨论\n\n预算与审批都已完成\n")]);
    let hits = vault
        .search(&SearchQuery {
            expr: SearchExpr::Line(Box::new(SearchExpr::And(vec![term("预算"), term("审批")]))),
            limit: 10,
        })
        .expect("检索");
    assert!(hits[0]
        .snippet
        .contains(&format!("{SNIPPET_START}预算{SNIPPET_END}与")));
}

#[test]
fn paragraph_identical_to_heading_does_not_start_a_section() {
    let (_root, _index, vault) =
        vault_with(&[("sections.md", "# 开始\n\n价格\n\n苹果\n\n## 价格\n\n便宜\n")]);
    assert!(paths(
        &vault,
        SearchExpr::Section(Box::new(SearchExpr::And(vec![
            term("价格"),
            term("苹果"),
            term("便宜"),
        ])))
    )
    .is_empty());
}

#[test]
fn boolean_planning_preserves_full_scan_truth_and_source_evidence() {
    let (_root, _index, vault) = vault_with(&[
        ("a.md", "---\nstatus: ready\nowner: LEWIS\n---\n# archive\n\n量子 archive #project/research\n\n## next\n\nbeta pending\n"),
        ("b.md", "---\nstatus: draft\n---\n# beta\n\narchive\n量子 pending #project2\n"),
        ("folder/c.md", "---\nowner: lewis\n---\n# 普通\n\n量子 beta #project\n"),
        ("folder/d.md", "archive beta approved\n"),
        ("e.md", "nothing here\n"),
        ("f.md", ""),
        ("g.md", "---\nstatus: READY\nowner: Else\n---\n# 量子\n\ni\u{307}stanbul İSTANBUL\n"),
    ]);
    let atoms = [
        term("archive"),
        term("beta"),
        term("量子"),
        term("İSTANBUL"),
        SearchExpr::Tag("project".into()),
        SearchExpr::Attr {
            key: "status".into(),
            value: Some("READY".into()),
        },
        SearchExpr::Attr {
            key: "owner".into(),
            value: None,
        },
        SearchExpr::Path("folder/".into()),
        SearchExpr::Regex("approved|pending".into()),
        SearchExpr::Not(Box::new(term("pending"))),
        SearchExpr::Line(Box::new(SearchExpr::And(vec![
            term("archive"),
            term("量子"),
        ]))),
        SearchExpr::Section(Box::new(SearchExpr::And(vec![
            term("archive"),
            term("beta"),
        ]))),
    ];
    for left in &atoms {
        for right in &atoms {
            for expr in [
                SearchExpr::Or(vec![left.clone(), right.clone()]),
                SearchExpr::And(vec![left.clone(), right.clone()]),
                SearchExpr::Or(vec![
                    SearchExpr::And(vec![term("archive"), left.clone()]),
                    SearchExpr::And(vec![term("beta"), right.clone()]),
                ]),
                SearchExpr::Line(Box::new(SearchExpr::Or(vec![left.clone(), right.clone()]))),
            ] {
                let mut actual = vault
                    .search(&SearchQuery {
                        expr: expr.clone(),
                        limit: 500,
                    })
                    .unwrap();
                // 双重否定保持完整语义，同时要求规划器保守扫描；独立检查每篇结果及每处证据。
                let mut expected = vault
                    .search(&SearchQuery {
                        expr: SearchExpr::Not(Box::new(SearchExpr::Not(Box::new(expr.clone())))),
                        limit: 500,
                    })
                    .unwrap();
                actual.sort_by(|a, b| a.path.cmp(&b.path));
                expected.sort_by(|a, b| a.path.cmp(&b.path));
                assert_eq!(actual, expected, "{expr:?}");
            }
        }
    }
}
