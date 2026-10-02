//! 在稳定语料中拆分候选召回、单篇精确定位、分页和索引发布；不改变生产 API。
use super::*;
use crate::{Vault, WriteOutcome};
use std::{fs, time::Instant};

fn measure(name: &str, mut run: impl FnMut()) {
    let mut times: Vec<f64> = (0..100)
        .map(|_| {
            let start = Instant::now();
            run();
            start.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    times.sort_by(f64::total_cmp);
    eprintln!(
        "{}",
        serde_json::json!({"phase": name, "samples":100, "p50_ms": times[49], "p95_ms": times[94], "p99_ms": times[98]})
    );
}

#[test]
#[ignore = "同机串行以 release 测量完整阶段，不计入日常测试"]
fn search_phases() {
    let count =
        std::env::var("NOEMORI_SEARCH_BENCH_NOTES").map_or(1000, |s| s.parse::<usize>().unwrap());
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    for i in 0..count {
        fs::write(
            root.path().join(format!("{i:05}.md")),
            format!(
                "# 研究记录 {i}\n\n{}",
                "中文定位 archive 与字节完整性。\n".repeat(60)
            ),
        )
        .unwrap();
    }
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let token = SearchCancellation::default();
    let query = SearchQuery {
        expr: SearchExpr::Term("archive".into()),
        limit: 100,
    };
    let mut conn = crate::index::open_connection(&index.path().join("index.sqlite")).unwrap();
    let mut engine = crate::index::fulltext::SearchIndex::open(index.path()).unwrap();
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    engine
        .synchronize(&transaction, &token, &mut |_, _| Ok(()))
        .unwrap();
    transaction.commit().unwrap();
    let snapshot = engine.snapshot().unwrap();
    let compiled = compile(&query.expr).unwrap().unwrap();
    let plan = Plan::of(&compiled);
    eprintln!(
        "{}",
        serde_json::json!({"notes":count,"matches_per_document":60})
    );
    measure("candidate_recall_101", || {
        let result = plan
            .ranked(&conn, &snapshot, &token)
            .unwrap()
            .page(0, 101)
            .unwrap();
        assert_eq!(result.len(), count.min(101));
        std::hint::black_box(result);
    });
    let context = DocContext::load(&conn, &compiled, &token).unwrap();
    let version = Cursor {
        revision: snapshot.revision.clone(),
        query: fingerprint(&query).unwrap(),
        position: Position::Ranked(0),
    };
    measure("one_document_exact_locations", || {
        let sql = format!("SELECT {DOCUMENT_COLUMNS} FROM search_sources JOIN files ON files.path = search_sources.path WHERE files.path = '00000.md'");
        let candidate = conn
            .query_row(&sql, [], |row| Ok(Candidate::read(row)))
            .unwrap()
            .unwrap();
        assert!(matches(&compiled, &candidate.doc(&context), None, &token).unwrap());
        let hit = occurrences::first(candidate, &compiled, &context, &version, &token).unwrap();
        assert_eq!(hit.match_count, 60);
        assert_eq!(hit.matches.len(), 5);
        assert!(hit.matches[0].location.is_some());
    });
    let first = vault.search_page(&query, None, &token).unwrap();
    let matches = first.hits[0].matches_cursor.as_ref().unwrap();
    measure("matches_next_20_with_snapshot", || {
        let page = vault.search_matches(&query, matches, &token).unwrap();
        assert_eq!(page.matches.len(), 20);
    });
    if let Some(cursor) = first.next_cursor {
        measure("next_100_documents_with_snapshot", || {
            std::hint::black_box(vault.search_page(&query, Some(&cursor), &token).unwrap());
        });
    }
    measure_publication(&vault, &token);
}

fn measure_publication(vault: &Vault, token: &SearchCancellation) {
    let mut times = Vec::new();
    let mut previous: Option<Vec<u8>> = None;
    for i in 0..100 {
        let next = format!("# 更新\n\nrevision {i}").into_bytes();
        assert!(matches!(
            vault
                .write("changed.md", &next, previous.as_deref())
                .unwrap(),
            WriteOutcome::Saved { warning: None }
        ));
        previous = Some(next);
        let started = Instant::now();
        vault.publish_search_index(token).unwrap();
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    eprintln!(
        "{}",
        serde_json::json!({"phase":"index_publication_only","samples":100,"p50_ms":times[49],"p95_ms":times[94],"p99_ms":times[98]})
    );
}
