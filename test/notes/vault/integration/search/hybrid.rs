//! 融合检索的公开契约：容错召回、硬筛选、稳定分页与严格查询隔离。

#[path = "../../support/search.rs"]
mod corpus;

use noemori_vault::{
    EvidenceKind, HybridQuery, SearchCancellation, SearchExpr, SearchQuery, SemanticState, Vault,
};
use sha2::{Digest, Sha256};
use std::{fmt::Write as _, fs};
use tempfile::TempDir;

fn fixture() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("engine.md"), "---\ntags: [research]\naliases: [Search handbook]\n---\n# Search engine\n\nDatabase transactions guarantee consistency.\n").unwrap();
    fs::write(
        root.path().join("other.md"),
        "# Gardening\n\nSearch for seasonal flowers.\n",
    )
    .unwrap();
    fs::write(
        root.path().join("chinese.md"),
        "# 数据库事务\n\n事务保证数据的一致性。\n",
    )
    .unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    (root, index, vault)
}

fn query(text: &str) -> HybridQuery {
    HybridQuery {
        text: text.into(),
        filter: SearchExpr::And(vec![]),
        limit: 100,
    }
}

#[test]
fn typo_recalls_real_word_without_changing_strict_matching() {
    let (_root, _index, vault) = fixture();
    let page = vault
        .search_hybrid(&query("serch"), None, &SearchCancellation::default())
        .unwrap();
    assert!(page.hits.iter().any(|hit| hit.hit.path == "engine.md"));
    assert!(page
        .hits
        .iter()
        .any(|hit| hit.evidence.iter().any(|e| e.kind == EvidenceKind::Fuzzy)));
    assert!(vault
        .search(&SearchQuery {
            expr: SearchExpr::Term("serch".into()),
            limit: 100
        })
        .unwrap()
        .is_empty());
    assert_eq!(page.semantic.state, SemanticState::Missing);
}

#[test]
fn metadata_filters_apply_before_candidates_are_limited() {
    let (_root, _index, vault) = fixture();
    let mut q = query("serch");
    q.filter = SearchExpr::Tag("research".into());
    q.limit = 1;
    let page = vault
        .search_hybrid(&q, None, &SearchCancellation::default())
        .unwrap();
    assert_eq!(page.hits.len(), 1);
    assert_eq!(page.hits[0].hit.path, "engine.md");
    assert!(page.next_cursor.is_none());
}

#[test]
fn title_alias_and_chinese_queries_are_recalled() {
    let (_root, _index, vault) = fixture();
    for (text, expected) in [
        ("Search handbook", "engine.md"),
        ("数据库事务", "chinese.md"),
    ] {
        let page = vault
            .search_hybrid(&query(text), None, &SearchCancellation::default())
            .unwrap();
        assert_eq!(page.hits[0].hit.path, expected);
    }
}

#[test]
fn pages_are_repeatable_and_reject_changed_content_or_query() {
    let (root, _index, vault) = fixture();
    let mut q = query("search");
    q.limit = 1;
    let token = SearchCancellation::default();
    let first = vault.search_hybrid(&q, None, &token).unwrap();
    let cursor = first.next_cursor.unwrap();
    let second = vault.search_hybrid(&q, Some(&cursor), &token).unwrap();
    assert_ne!(first.hits[0].hit.path, second.hits[0].hit.path);
    assert_eq!(
        second.hits[0].hit.path,
        vault.search_hybrid(&q, Some(&cursor), &token).unwrap().hits[0]
            .hit
            .path
    );
    assert!(vault
        .search_hybrid(&query("other"), Some(&cursor), &token)
        .is_err());
    fs::write(root.path().join("other.md"), "# Changed\n").unwrap();
    vault.refresh_index().unwrap();
    assert!(matches!(
        vault.search_hybrid(&q, Some(&cursor), &token),
        Err(noemori_vault::Error::SearchExpired)
    ));
}

#[test]
fn invalid_filter_and_cancelled_queries_do_not_return_partial_success() {
    let (_root, _index, vault) = fixture();
    let mut q = query("search");
    q.filter = SearchExpr::Term("database".into());
    assert!(vault
        .search_hybrid(&q, None, &SearchCancellation::default())
        .is_err());
    let token = SearchCancellation::default();
    token.cancel();
    assert!(matches!(
        vault.search_hybrid(&query("search"), None, &token),
        Err(noemori_vault::Error::SearchCancelled)
    ));
}

#[test]
fn cancelled_installation_does_not_report_a_broken_model() {
    let (_root, _index, vault) = fixture();
    let token = SearchCancellation::default();
    token.cancel();
    assert!(matches!(
        vault.install_search_model(None, &token),
        Err(noemori_vault::Error::SearchCancelled)
    ));
    assert_eq!(
        vault.semantic_status().unwrap().state,
        SemanticState::Missing
    );
}

#[test]
fn occurrence_cursor_is_bound_to_the_complete_hybrid_filter() {
    let (root, _index, vault) = fixture();
    fs::write(
        root.path().join("engine.md"),
        format!(
            "---\ntags: [research]\n---\n# Matches\n\n{}",
            "needle ".repeat(30)
        ),
    )
    .unwrap();
    vault.refresh_index().unwrap();
    let mut original = query("needle");
    original.filter = SearchExpr::Tag("research".into());
    let token = SearchCancellation::default();
    let page = vault.search_hybrid(&original, None, &token).unwrap();
    let cursor = page.hits[0].hit.matches_cursor.as_ref().unwrap();
    let mut changed = original.clone();
    changed.filter = SearchExpr::Tag("other".into());
    assert!(vault.hybrid_matches(&changed, cursor, &token).is_err());
    let mut forged: serde_json::Value = serde_json::from_str(cursor).unwrap();
    let identity = Sha256::digest(serde_json::to_vec(&changed).unwrap())
        .iter()
        .fold(String::new(), |mut text, byte| {
            write!(text, "{byte:02x}").unwrap();
            text
        });
    forged["query"] = serde_json::Value::String(identity);
    assert!(vault
        .hybrid_matches(&changed, &serde_json::to_string(&forged).unwrap(), &token)
        .is_err());
    assert_eq!(
        vault
            .hybrid_matches(&original, cursor, &token)
            .unwrap()
            .matches
            .len(),
        20
    );
}

#[test]
fn reopening_a_vault_cannot_revive_an_old_result_session() {
    let (root, index, vault) = fixture();
    let mut q = query("search");
    q.limit = 1;
    let token = SearchCancellation::default();
    let cursor = vault
        .search_hybrid(&q, None, &token)
        .unwrap()
        .next_cursor
        .unwrap();
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    reopened.search_hybrid(&q, None, &token).unwrap();
    assert!(reopened.search_hybrid(&q, Some(&cursor), &token).is_err());
}

#[test]
#[ignore = "显式安装约 1.1 GB Harrier 模型，并验证真实本地推理"]
fn harrier_recalls_semantic_content_and_reindexes_changes() {
    let directory = std::env::var("NOEMORI_HARRIER_MODELS").expect("设置模型缓存目录");
    let (root, _index, vault) = fixture();
    vault
        .configure_search_model(std::path::Path::new(&directory))
        .unwrap();
    let token = SearchCancellation::default();
    vault.install_search_model(None, &token).unwrap();
    vault.publish_semantic_index(&token).unwrap();
    let page = vault
        .search_hybrid(&query("如何保证数据一致性"), None, &token)
        .unwrap();
    assert_eq!(page.semantic.state, SemanticState::Ready);
    assert!(
        page.hits.iter().any(|hit| hit
            .evidence
            .iter()
            .any(|e| e.kind == EvidenceKind::Semantic && e.location.is_some())),
        "{page:#?}"
    );
    assert_ne!(page.hits[0].hit.path, "other.md");
    fs::remove_file(root.path().join("engine.md")).unwrap();
    vault.refresh_index().unwrap();
    vault.publish_semantic_index(&token).unwrap();
    let page = vault
        .search_hybrid(&query("Database consistency"), None, &token)
        .unwrap();
    assert!(page.hits.iter().all(|hit| hit.hit.path != "engine.md"));
    assert_eq!(page.semantic.indexed, 2);
}

#[test]
#[ignore = "真实 Harrier 与词法路线的融合相关性回归"]
fn harrier_fusion_relevance() {
    let cache = std::env::var("NOEMORI_HARRIER_MODELS").expect("模型缓存目录");
    let fixture = corpus::Corpus::load();
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    for (i, document) in fixture.documents.iter().enumerate() {
        fs::write(
            root.path().join(format!("{i}.md")),
            format!("# {}\n\n{}\n", fixture.titles[i], document),
        )
        .unwrap();
    }
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let token = SearchCancellation::default();
    let mut baseline = 0.0;
    for case in &fixture.queries {
        let hits = vault
            .search_hybrid(&query(&case.text), None, &token)
            .unwrap()
            .hits;
        let expected = format!("{}.md", case.expected);
        if let Some(rank) = hits.iter().position(|hit| hit.hit.path == expected) {
            baseline += 1.0 / f64::from(u32::try_from(rank + 2).unwrap()).log2();
        }
    }
    vault
        .configure_search_model(std::path::Path::new(&cache))
        .unwrap();
    vault.install_search_model(None, &token).unwrap();
    vault.publish_semantic_index(&token).unwrap();
    let mut fused = 0.0;
    for case in &fixture.queries {
        let text = &case.text;
        let hits = vault
            .search_hybrid(&query(text), None, &token)
            .unwrap()
            .hits;
        let expected = format!("{}.md", case.expected);
        eprintln!(
            "query={text} expected={expected} hits={:?}",
            hits.iter().map(|hit| &hit.hit.path).collect::<Vec<_>>()
        );
        assert_eq!(hits.first().map(|hit| &hit.hit.path), Some(&expected));
        if let Some(rank) = hits.iter().position(|hit| hit.hit.path == expected) {
            fused += 1.0 / f64::from(u32::try_from(rank + 2).unwrap()).log2();
        }
    }
    eprintln!("controlled_relevance baseline_dcg={baseline:.3} fused_dcg={fused:.3}");
    assert!(fused > baseline * 1.10);
}
