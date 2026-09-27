//! 检索表达式：OR、取反、正则、文件名、属性存在、line: 与 section: 的组合语义。

use nous_core::{Error, SearchExpr, SearchQuery, Vault, SNIPPET_END, SNIPPET_START};
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
