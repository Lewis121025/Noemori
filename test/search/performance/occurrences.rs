//! 单篇高密度命中的按需交付基准；包括精确计数、源码映射和真实后续页。

use nous_vault::{SearchCancellation, SearchExpr, SearchQuery, Vault};
use std::{fs, time::Instant};
use tempfile::TempDir;

#[test]
#[ignore = "使用 --release --ignored --nocapture 验证单篇十万处命中的成本"]
fn hundred_thousand_occurrences() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("dense.md"), "needle ".repeat(100_000)).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let query = SearchQuery {
        expr: SearchExpr::Or(vec![
            SearchExpr::Term("needle".into()),
            SearchExpr::Regex("needle".into()),
        ]),
        limit: 100,
    };
    let mut initial_samples = Vec::new();
    let mut page_samples = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let hit = vault.search(&query).unwrap().remove(0);
        initial_samples.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(hit.match_count, 100_000);
        assert_eq!(hit.matches.len(), 5);
        let cursor = hit.matches_cursor.unwrap();
        let response_bytes = hit
            .matches
            .iter()
            .map(|item| item.snippet.len())
            .sum::<usize>()
            + cursor.len();
        assert!(response_bytes < 4096, "首批摘要与游标必须保持有界");
        let start = Instant::now();
        let page = vault
            .search_matches(&query, &cursor, &SearchCancellation::default())
            .unwrap();
        page_samples.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(page.matches.len(), 20);
        assert_eq!(page.matches[0].location.as_ref().unwrap().start_byte, 35);
        assert_eq!(page.matches[19].location.as_ref().unwrap().start_byte, 168);
        assert!(page.next_cursor.is_some());
        std::hint::black_box(page);
    }
    initial_samples.sort_by(f64::total_cmp);
    page_samples.sort_by(f64::total_cmp);
    eprintln!(
        "100000_occurrences: initial_p95_ms={:.2} next_20_p95_ms={:.2}",
        initial_samples[18], page_samples[18]
    );
    assert!(initial_samples[18] <= 150.0, "高密度首屏超过 150ms 预算");
    assert!(page_samples[18] <= 150.0, "高密度续页超过 150ms 预算");
}
