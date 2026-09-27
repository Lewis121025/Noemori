//! 分页、取消与写入隔离的公开契约；游标不可混用查询或正文版本。

use nous_core::{Error, SearchCancellation, SearchExpr, SearchQuery, Vault};
use std::{
    collections::HashSet,
    fs,
    sync::{mpsc, Arc},
    thread,
    time::Duration,
};
use tempfile::TempDir;

fn fixture() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    for number in 0..23 {
        fs::write(
            root.path().join(format!("{number:02}.md")),
            format!(
                "archive 量子\n{}\n",
                if number % 3 == 0 {
                    "approved"
                } else {
                    "pending"
                }
            ),
        )
        .unwrap();
    }
    let vault = Vault::open(root.path(), index.path()).unwrap();
    (root, index, vault)
}

#[test]
fn ranked_and_scan_pages_have_no_duplicates_or_missing_documents() {
    let (_root, _index, vault) = fixture();
    for expr in [
        SearchExpr::Term("archive".into()),
        SearchExpr::Term("量子".into()),
        SearchExpr::Regex("approved".into()),
        SearchExpr::And(vec![
            SearchExpr::Term("archive".into()),
            SearchExpr::Regex("approved".into()),
        ]),
        SearchExpr::Or(vec![
            SearchExpr::Term("archive".into()),
            SearchExpr::Term("approved".into()),
        ]),
        SearchExpr::Or(vec![
            SearchExpr::Term("archive".into()),
            SearchExpr::Term("量子".into()),
        ]),
        SearchExpr::Or(vec![
            SearchExpr::Term("量子".into()),
            SearchExpr::Term("稀缺".into()),
        ]),
        SearchExpr::Or(vec![
            SearchExpr::And(vec![
                SearchExpr::Term("archive".into()),
                SearchExpr::Regex("approved".into()),
            ]),
            SearchExpr::Term("absent".into()),
        ]),
    ] {
        let expected = vault
            .search(&SearchQuery {
                expr: expr.clone(),
                limit: 500,
            })
            .unwrap();
        let query = SearchQuery { expr, limit: 4 };
        let mut cursor = None;
        let mut hits = Vec::new();
        loop {
            let page = vault
                .search_page(&query, cursor.as_deref(), &SearchCancellation::default())
                .unwrap();
            assert!(page.hits.len() <= 4);
            if page.next_cursor.is_some() {
                assert_eq!(page.hits.len(), 4);
            }
            hits.extend(page.hits);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
            assert!(hits.len() <= 23);
        }
        assert_eq!(hits, expected);
        assert_eq!(
            hits.iter()
                .map(|hit| &hit.path)
                .collect::<HashSet<_>>()
                .len(),
            hits.len()
        );
    }
}

#[test]
fn ranking_across_segments_is_stable_and_complete_for_every_page() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let expr = SearchExpr::And(vec![
        SearchExpr::Term("archive".into()),
        SearchExpr::Term("implementation".into()),
    ]);
    let complete = SearchQuery {
        expr: expr.clone(),
        limit: 100,
    };
    for batch in 0..3 {
        for note in 0..4 {
            let number = batch * 4 + note;
            let title = if number == 11 {
                "archive implementation"
            } else {
                "note"
            };
            fs::write(
                root.path().join(format!("{number:02}.md")),
                format!("# {title}\n\narchive implementation\n"),
            )
            .unwrap();
        }
        vault.refresh_index().unwrap();
        vault.search(&complete).unwrap();
    }
    // 三次独立提交保留多个索引段，覆盖并行收集后的合并与同分稳定顺序。
    let engine = tantivy::Index::open_in_dir(index.path().join("search-v1")).unwrap();
    assert!(engine.searchable_segment_ids().unwrap().len() > 1);
    let expected = vault.search(&complete).unwrap();
    assert_eq!(expected.len(), 12);
    assert_eq!(
        expected[0].path, "11.md",
        "最后提交的标题强命中仍应全局优先"
    );
    let query = SearchQuery { expr, limit: 3 };
    let token = SearchCancellation::default();
    let mut cursor = None;
    let mut actual = Vec::new();
    loop {
        let page = vault
            .search_page(&query, cursor.as_deref(), &token)
            .unwrap();
        assert_eq!(
            page,
            vault
                .search_page(&query, cursor.as_deref(), &token)
                .unwrap()
        );
        actual.extend(page.hits);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
        assert!(actual.len() < expected.len());
    }
    assert_eq!(actual, expected);
}

#[test]
fn cursors_are_repeatable_and_bound_to_query_and_revision() {
    let (_root, index, vault) = fixture();
    let query = SearchQuery {
        expr: SearchExpr::Term("archive".into()),
        limit: 4,
    };
    let token = SearchCancellation::default();
    let cursor = vault
        .search_page(&query, None, &token)
        .unwrap()
        .next_cursor
        .unwrap();
    let second = vault.search_page(&query, Some(&cursor), &token).unwrap();
    assert_eq!(
        vault.search_page(&query, Some(&cursor), &token).unwrap(),
        second
    );
    let other = SearchQuery {
        expr: SearchExpr::Term("量子".into()),
        limit: 4,
    };
    assert!(matches!(
        vault.search_page(&other, Some(&cursor), &token),
        Err(Error::InvalidQuery { .. })
    ));
    assert!(matches!(
        vault.search_page(&query, Some("{}"), &token),
        Err(Error::InvalidQuery { .. })
    ));
    vault.write("new.md", b"archive", None).unwrap();
    // 续页之间没有打开的读事务，检查点能够完成，搜索不会长期钉住 WAL。
    let conn = rusqlite::Connection::open(index.path().join("index.sqlite")).unwrap();
    let busy: i64 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .unwrap();
    assert_eq!(busy, 0);
    assert!(matches!(
        vault.search_page(&query, Some(&cursor), &token),
        Err(Error::SearchExpired)
    ));
}

#[test]
fn exactly_full_last_page_has_no_spurious_next_cursor() {
    let (_root, _index, vault) = fixture();
    let query = SearchQuery {
        expr: SearchExpr::Regex("approved".into()),
        limit: 8,
    };
    let page = vault
        .search_page(&query, None, &SearchCancellation::default())
        .unwrap();
    assert_eq!(page.hits.len(), 8);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn cancelled_search_does_not_publish_partial_results_or_poison_later_queries() {
    let (_root, _index, vault) = fixture();
    let query = SearchQuery {
        expr: SearchExpr::Term("archive".into()),
        limit: 4,
    };
    let token = SearchCancellation::default();
    token.cancel();
    assert!(matches!(
        vault.search_page(&query, None, &token),
        Err(Error::SearchCancelled)
    ));
    assert_eq!(vault.search(&query).unwrap().len(), 4);
}

#[test]
fn occurrence_pages_preserve_order_exact_count_and_source_ranges() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    let source = "预**算** needle needle\n\n".repeat(43);
    fs::write(root.path().join("dense.md"), &source).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    for expr in [
        SearchExpr::Term("needle".into()),
        SearchExpr::Regex("needle".into()),
        SearchExpr::Or(vec![
            SearchExpr::Term("needle".into()),
            SearchExpr::Regex("needle".into()),
        ]),
        SearchExpr::Line(Box::new(SearchExpr::And(vec![
            SearchExpr::Term("预算".into()),
            SearchExpr::Term("needle".into()),
        ]))),
    ] {
        let query = SearchQuery {
            expr: expr.clone(),
            limit: 100,
        };
        let first = vault.search(&query).unwrap().remove(0);
        let mut all = first.matches;
        let mut cursor = first.matches_cursor;
        while let Some(current) = cursor {
            let next = vault
                .search_matches(&query, &current, &SearchCancellation::default())
                .unwrap();
            assert_eq!(
                next,
                vault
                    .search_matches(&query, &current, &SearchCancellation::default())
                    .unwrap()
            );
            assert!(!next.matches.is_empty() && next.matches.len() <= 20);
            all.extend(next.matches);
            cursor = next.next_cursor;
            assert!(all.len() <= usize::try_from(first.match_count).unwrap());
        }
        let expected = source
            .match_indices("needle")
            .map(|(start, _)| (start, start + 6));
        let mut expected = expected.collect::<Vec<_>>();
        if matches!(expr, SearchExpr::Line(_)) {
            expected.extend(
                source
                    .match_indices("预**算**")
                    // 范围结束在最后一个正文字符后，不吞掉尾部的 Markdown 闭合标记。
                    .map(|(start, _)| (start, start + "预**算".len())),
            );
            expected.sort_unstable();
        }
        let actual = all
            .iter()
            .map(|item| {
                let location = item.location.as_ref().unwrap();
                (
                    usize::try_from(location.start_byte).unwrap(),
                    usize::try_from(location.end_byte).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
        assert_eq!(usize::try_from(first.match_count).unwrap(), expected.len());
    }
}

#[test]
fn occurrence_cursor_rejects_other_queries_versions_positions_and_cancellation() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("a.md"), "needle ".repeat(25)).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let query = SearchQuery {
        expr: SearchExpr::Term("needle".into()),
        limit: 100,
    };
    let cursor = vault.search(&query).unwrap()[0]
        .matches_cursor
        .clone()
        .unwrap();
    let token = SearchCancellation::default();
    let last = vault.search_matches(&query, &cursor, &token).unwrap();
    assert_eq!(last.matches.len(), 20);
    assert!(last.next_cursor.is_none(), "恰好满页不能制造空的下一页");
    let changed = SearchQuery {
        expr: SearchExpr::Term("need".into()),
        limit: 100,
    };
    assert!(matches!(
        vault.search_matches(&changed, &cursor, &token),
        Err(Error::InvalidQuery { .. })
    ));
    let mut forged: serde_json::Value = serde_json::from_str(&cursor).unwrap();
    forged["after"] = serde_json::json!({"start": 1, "end": 3});
    assert!(matches!(
        vault.search_matches(&query, &forged.to_string(), &token),
        Err(Error::InvalidQuery { .. })
    ));
    let cancelled = SearchCancellation::default();
    cancelled.cancel();
    assert!(matches!(
        vault.search_matches(&query, &cursor, &cancelled),
        Err(Error::SearchCancelled)
    ));
    vault.write("new.md", b"other", None).unwrap();
    assert!(matches!(
        vault.search_matches(&query, &cursor, &token),
        Err(Error::SearchExpired)
    ));
}

#[test]
fn overlapping_and_nested_evidence_is_sorted_and_deduplicated_before_counting() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    let source = "aaaa\n\n".repeat(10);
    fs::write(root.path().join("a.md"), &source).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let query = SearchQuery {
        expr: SearchExpr::Or(vec![
            SearchExpr::Term("aa".into()),
            SearchExpr::Regex("a+".into()),
            SearchExpr::Line(Box::new(SearchExpr::Term("aa".into()))),
        ]),
        limit: 100,
    };
    let first = vault.search(&query).unwrap().remove(0);
    assert_eq!(first.match_count, 30);
    let mut all = first.matches;
    let mut cursor = first.matches_cursor;
    while let Some(current) = cursor {
        let page = vault
            .search_matches(&query, &current, &SearchCancellation::default())
            .unwrap();
        all.extend(page.matches);
        cursor = page.next_cursor;
    }
    let actual = all
        .iter()
        .map(|item| {
            let location = item.location.as_ref().unwrap();
            (location.start_byte, location.end_byte)
        })
        .collect::<Vec<_>>();
    let expected = (0..10)
        .flat_map(|line| {
            [
                (line * 6, line * 6 + 2),
                (line * 6, line * 6 + 4),
                (line * 6 + 2, line * 6 + 4),
            ]
        })
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

#[test]
fn running_full_scan_releases_promptly_and_does_not_hold_the_writer_connection() {
    let (root, _index, vault) = fixture();
    for number in 0..64 {
        fs::write(
            root.path().join(format!("large-{number}.md")),
            "a".repeat(128_000),
        )
        .unwrap();
    }
    vault.refresh_index().unwrap();
    // 排名预先同步，使本例只观测查询执行与保存之间的隔离。
    vault.search(&SearchQuery::default()).unwrap();
    let vault = Arc::new(vault);
    let token = SearchCancellation::default();
    let task_token = token.clone();
    let reader = Arc::clone(&vault);
    let (send, receive) = mpsc::channel();
    let search = thread::spawn(move || {
        send.send(reader.search_page(
            &SearchQuery {
                expr: SearchExpr::Or(vec![
                    SearchExpr::Term(format!("{}b", "a".repeat(1024))),
                    // 保留不能下推的分支，确保取消验证始终覆盖在途正文扫描。
                    SearchExpr::Regex("absent".into()),
                ]),
                limit: 4,
            },
            None,
            &task_token,
        ))
        .unwrap();
    });
    thread::sleep(Duration::from_millis(30));
    assert!(matches!(receive.try_recv(), Err(mpsc::TryRecvError::Empty)));
    let writer = Arc::clone(&vault);
    let (written, saved) = mpsc::channel();
    let write = thread::spawn(move || {
        written
            .send(writer.write("new.md", b"saved", None))
            .unwrap();
    });
    let result = saved.recv_timeout(Duration::from_secs(2));
    token.cancel();
    assert!(result.expect("全文扫描不能持有保存连接").is_ok());
    assert!(matches!(
        receive.recv_timeout(Duration::from_secs(2)).unwrap(),
        Err(Error::SearchCancelled)
    ));
    search.join().unwrap();
    write.join().unwrap();
}
