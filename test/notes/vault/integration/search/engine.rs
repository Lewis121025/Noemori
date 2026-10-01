//! 排名索引与 `SQLite` 正文快照的一致性；中断后只允许重放或重建，不能返回旧命中。

use noemori_vault::{SearchExpr, SearchQuery, Vault};
use std::fs;
use tempfile::TempDir;

#[test]
fn dense_occurrences_do_not_overfill_the_initial_page() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("dense.md"), "needle\n".repeat(20_000)).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let hit = vault
        .search(&SearchQuery {
            expr: SearchExpr::Term("needle".into()),
            limit: 100,
        })
        .unwrap()
        .remove(0);
    assert_eq!(hit.matches.len(), 5, "首批只生成展示所需的具体命中");
    assert_eq!(hit.match_count, 20_000);
    assert!(hit.matches_cursor.is_some());
}

#[test]
fn a_regex_matching_the_whole_document_has_a_bounded_snippet() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("long.md"), "预算".repeat(10_000)).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let hit = vault
        .search(&SearchQuery {
            expr: SearchExpr::Regex(".+".into()),
            limit: 100,
        })
        .unwrap()
        .remove(0);
    assert!(hit.matches[0].snippet.chars().count() <= 205);
    assert_eq!(hit.matches[0].location.as_ref().unwrap().end_byte, 60_000);
}

#[test]
fn a_long_match_in_the_middle_preserves_its_range_within_the_snippet_budget() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    let source = format!(
        "{}{}{}",
        "前".repeat(60),
        "预算".repeat(10_000),
        "后".repeat(60)
    );
    fs::write(root.path().join("long.md"), source).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let hit = vault
        .search(&SearchQuery {
            expr: SearchExpr::Regex("(?:预算)+".into()),
            limit: 100,
        })
        .unwrap()
        .remove(0);
    // 前后各 40 字、命中 120 字，加三处省略号和两个高亮边界。
    assert!(hit.matches[0].snippet.chars().count() <= 205);
    let location = hit.matches[0].location.as_ref().unwrap();
    assert_eq!((location.start_byte, location.end_byte), (180, 60_180));
}

fn paths(vault: &Vault, term: &str) -> Vec<String> {
    vault
        .search(&SearchQuery {
            expr: SearchExpr::Term(term.into()),
            limit: 100,
        })
        .unwrap()
        .into_iter()
        .map(|hit| hit.path)
        .collect()
}

fn setup() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("a.md"), "originalword\n").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    (root, index, vault)
}

fn probe(index: &TempDir) -> rusqlite::Connection {
    rusqlite::Connection::open(index.path().join("index.sqlite")).unwrap()
}

#[test]
fn pending_changes_replay_after_reopen() {
    let (root, index, vault) = setup();
    assert_eq!(paths(&vault, "originalword"), ["a.md"]);
    vault
        .write("a.md", b"replacementword\n", Some(b"originalword\n"))
        .unwrap();
    let pending: i64 = probe(&index)
        .query_row("SELECT count(*) FROM search_pending", [], |row| row.get(0))
        .unwrap();
    assert_eq!(pending, 1);
    drop(vault);
    let vault = Vault::open(root.path(), index.path()).unwrap();
    assert!(paths(&vault, "originalword").is_empty());
    assert_eq!(paths(&vault, "replacementword"), ["a.md"]);
}

#[test]
fn committed_engine_replays_when_acknowledgement_fails() {
    let (_root, index, vault) = setup();
    vault
        .write("a.md", b"replacementword\n", Some(b"originalword\n"))
        .unwrap();
    let conn = probe(&index);
    conn.execute_batch("CREATE TRIGGER reject_search_ack BEFORE DELETE ON search_pending BEGIN SELECT RAISE(ABORT, 'injected acknowledgement failure'); END;").unwrap();
    assert!(vault
        .search(&SearchQuery {
            expr: SearchExpr::Term("replacementword".into()),
            limit: 100,
        })
        .is_err());
    conn.execute_batch("DROP TRIGGER reject_search_ack")
        .unwrap();
    assert!(paths(&vault, "originalword").is_empty());
    assert_eq!(paths(&vault, "replacementword"), ["a.md"]);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM search_pending", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn failed_engine_commit_keeps_changes_for_retry() {
    let (_root, index, vault) = setup();
    let external = tantivy::Index::open_in_dir(index.path().join("search-v1")).unwrap();
    external.tokenizers().register(
        "trigram",
        tantivy::tokenizer::NgramTokenizer::new(3, 3, false).unwrap(),
    );
    let writer = external
        .writer::<tantivy::TantivyDocument>(50_000_000)
        .unwrap();
    vault
        .write("a.md", b"replacementword\n", Some(b"originalword\n"))
        .unwrap();
    assert!(vault
        .search(&SearchQuery {
            expr: SearchExpr::Term("replacementword".into()),
            limit: 100
        })
        .is_err());
    assert_eq!(
        probe(&index)
            .query_row("SELECT count(*) FROM search_pending", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(writer);
    assert_eq!(paths(&vault, "replacementword"), ["a.md"]);
    assert!(paths(&vault, "originalword").is_empty());
}

#[test]
fn missing_engine_rebuilds_from_current_sources() {
    let (root, index, vault) = setup();
    assert_eq!(paths(&vault, "originalword"), ["a.md"]);
    drop(vault);
    fs::remove_dir_all(index.path().join("search-v1")).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(paths(&vault, "originalword"), ["a.md"]);
}

#[test]
fn missing_source_table_invalidates_engine_row_ids() {
    let (root, index, vault) = setup();
    drop(vault);
    fs::remove_file(root.path().join("a.md")).unwrap();
    fs::write(root.path().join("b.md"), "replacementword\n").unwrap();
    probe(&index)
        .execute_batch("DROP TABLE search_sources")
        .unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    assert!(paths(&vault, "originalword").is_empty());
    assert_eq!(paths(&vault, "replacementword"), ["b.md"]);
}

#[test]
fn independent_readers_observe_the_latest_committed_revision() {
    let (root, index, first) = setup();
    let second = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(paths(&first, "originalword"), ["a.md"]);
    second
        .write("a.md", b"replacementword\n", Some(b"originalword\n"))
        .unwrap();
    assert_eq!(paths(&second, "replacementword"), ["a.md"]);
    assert!(paths(&first, "originalword").is_empty());
    assert_eq!(paths(&first, "replacementword"), ["a.md"]);
}

#[test]
fn unchanged_searches_do_not_write_sqlite() {
    let (_root, index, vault) = setup();
    let conn = probe(&index);
    let before: i64 = conn
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    for _ in 0..3 {
        assert_eq!(paths(&vault, "originalword"), ["a.md"]);
    }
    let after: i64 = conn
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(before, after, "只读搜索不能让其它读取实例误判索引变化");
}

#[test]
fn failed_source_deletion_preserves_its_file_and_pending_revision() {
    let (root, index, vault) = setup();
    fs::write(root.path().join("deleted.md"), "preservedword\n").unwrap();
    vault.refresh_index().unwrap();
    assert_eq!(paths(&vault, "preservedword"), ["deleted.md"]);
    let conn = probe(&index);
    conn.execute_batch("CREATE TRIGGER reject_source_delete BEFORE DELETE ON search_sources WHEN old.path = 'deleted.md' BEGIN SELECT RAISE(ABORT, 'injected source deletion failure'); END;").unwrap();
    fs::remove_file(root.path().join("deleted.md")).unwrap();
    let _ = vault
        .write("a.md", b"replacementword\n", Some(b"originalword\n"))
        .unwrap();
    let retained: i64 = conn
        .query_row(
            "SELECT count(*) FROM files WHERE path = 'deleted.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 1, "索引删除失败时，文件行与来源行必须一起回滚");
    assert_eq!(paths(&vault, "preservedword"), ["deleted.md"]);
    conn.execute_batch("DROP TRIGGER reject_source_delete")
        .unwrap();
    vault.refresh_index().unwrap();
    assert!(paths(&vault, "preservedword").is_empty());
    assert_eq!(paths(&vault, "replacementword"), ["a.md"]);
}

#[test]
fn global_ranking_and_sql_filters_precede_the_result_limit() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    for note in 0..160 {
        fs::write(root.path().join(format!("{note:03}.md")), "archive\n").unwrap();
    }
    fs::write(root.path().join("winner.md"), "# archive\n\n量子\n").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    for expr in [
        SearchExpr::Term("archive".into()),
        SearchExpr::And(vec![
            SearchExpr::Term("archive".into()),
            SearchExpr::Term("量子".into()),
        ]),
    ] {
        let hits = vault.search(&SearchQuery { expr, limit: 1 }).unwrap();
        assert_eq!(hits[0].path, "winner.md");
    }
}

#[test]
fn phrase_positions_preserve_substrings_and_repeated_grams() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(
        root.path().join("yes.md"),
        "prefixARCHIVEsuffix aaaaa 中文全文检索 i\u{307}stanbul\n",
    )
    .unwrap();
    fs::write(
        root.path().join("no.md"),
        "arc chi hiv ive 甲全文乙文检丙检索\n",
    )
    .unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    for term in ["archive", "aaaa", "全文检索", "İSTANBUL"] {
        assert_eq!(paths(&vault, term), ["yes.md"], "{term}");
    }
}

#[test]
fn spaced_trigrams_match_the_complete_literal_for_every_phrase_length() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    let bodies = [
        "abcde量子预算abcdefghi量子预算abcd",
        "abcde量子甲算abcdefghi量子预算abcd",
        "abcde量子预算abc乙efghi量子预算abcd",
        "aaaaaaaaaaaaaaaaaaaaaa",
        "abcXdefXghiX量子X预算Xabcd",
    ];
    for (note, body) in bodies.iter().enumerate() {
        fs::write(root.path().join(format!("{note}.md")), body).unwrap();
    }
    let vault = Vault::open(root.path(), index.path()).unwrap();
    for body in &bodies[..4] {
        let chars = body.chars().collect::<Vec<_>>();
        for size in 3..=19.min(chars.len()) {
            for start in (0..=chars.len() - size).step_by(3) {
                let term = chars[start..start + size].iter().collect::<String>();
                let mut actual = paths(&vault, &term);
                actual.sort();
                let expected = bodies
                    .iter()
                    .enumerate()
                    .filter(|(_, text)| text.contains(&term))
                    .map(|(note, _)| format!("{note}.md"))
                    .collect::<Vec<_>>();
                assert_eq!(actual, expected, "{term}");
            }
        }
    }
}

#[test]
fn residual_filters_continue_beyond_the_first_ranked_page() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    for note in 0..180 {
        fs::write(
            root.path().join(format!("{note:03}.md")),
            "# archive\n\narchive\n",
        )
        .unwrap();
    }
    fs::write(
        root.path().join("last.md"),
        format!("{}\n\narchive approved\n", "filler ".repeat(100)),
    )
    .unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let hits = vault
        .search(&SearchQuery {
            expr: SearchExpr::Line(Box::new(SearchExpr::And(vec![
                SearchExpr::Term("archive".into()),
                SearchExpr::Regex("approved".into()),
            ]))),
            limit: 1,
        })
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "last.md");
    assert_eq!(hits[0].matches[0].location.as_ref().unwrap().line, 3);
}

#[test]
fn or_ranks_all_branches_before_applying_the_page_limit() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    for note in 0..160 {
        fs::write(root.path().join(format!("{note:03}.md")), "archive\n").unwrap();
    }
    fs::write(root.path().join("winner.md"), "# archive\n").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let hits = vault
        .search(&SearchQuery {
            expr: SearchExpr::Or(vec![
                SearchExpr::Term("archive".into()),
                SearchExpr::Term("absent".into()),
            ]),
            limit: 1,
        })
        .unwrap();
    assert_eq!(hits[0].path, "winner.md");
}

#[test]
fn boolean_candidates_skip_unrelated_source_maps() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("unrelated.md"), "unrelated\n").unwrap();
    fs::write(root.path().join("long.md"), "archive\n").unwrap();
    fs::write(root.path().join("short.md"), "量子\n").unwrap();
    fs::write(root.path().join("tag.md"), "#project/research\n").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    // 注入只能在读取正文候选时触发的故障，证明并集筛选发生在正文解码之前。
    probe(&index)
        .execute(
            "UPDATE search_sources SET source_map = 'invalid' WHERE path = 'unrelated.md'",
            [],
        )
        .unwrap();
    for (branch, expected) in [
        (SearchExpr::Term("missing".into()), vec!["long.md"]),
        (SearchExpr::Term("量子".into()), vec!["long.md", "short.md"]),
        (SearchExpr::Tag("project".into()), vec!["long.md", "tag.md"]),
    ] {
        let mut actual = vault
            .search(&SearchQuery {
                expr: SearchExpr::Or(vec![SearchExpr::Term("archive".into()), branch]),
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|hit| hit.path)
            .collect::<Vec<_>>();
        actual.sort();
        assert_eq!(actual, expected);
    }
    let hits = vault
        .search(&SearchQuery {
            expr: SearchExpr::Or(vec![
                SearchExpr::Term("量子".into()),
                SearchExpr::Term("稀缺".into()),
            ]),
            limit: 10,
        })
        .unwrap();
    assert_eq!(hits[0].path, "short.md");
}

#[test]
fn undecodable_markdown_keeps_its_searchable_filename() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("archive-量子.md"), [0xff, 0xfe]).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    for term in ["archive", "量子"] {
        assert_eq!(paths(&vault, term), ["archive-量子.md"]);
    }
    let hits = vault
        .search(&SearchQuery {
            expr: SearchExpr::Or(vec![
                SearchExpr::Term("absent".into()),
                SearchExpr::Path("archive".into()),
            ]),
            limit: 10,
        })
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].matches.is_empty(), "不可解码的正文不能产生虚构位置");
    drop(vault);
    // 旧版本没有为这类文件创建来源行，升级必须修复已有库，不能只对新库生效。
    let conn = probe(&index);
    conn.execute_batch(
        "DELETE FROM search_short; DELETE FROM search_sources; PRAGMA user_version = 12;",
    )
    .unwrap();
    drop(conn);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    for term in ["archive", "量子"] {
        assert_eq!(paths(&reopened, term), ["archive-量子.md"]);
    }
}

#[test]
fn or_branch_filters_precede_ranking_and_survive_source_replacement() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    for note in 0..160 {
        fs::write(root.path().join(format!("{note:03}.md")), "# archive\n").unwrap();
    }
    fs::write(root.path().join("winner.md"), "archive #project\n").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let query = SearchQuery {
        expr: SearchExpr::Or(vec![
            SearchExpr::And(vec![
                SearchExpr::Term("archive".into()),
                SearchExpr::Tag("project".into()),
            ]),
            SearchExpr::Term("量子".into()),
        ]),
        limit: 1,
    };
    assert_eq!(vault.search(&query).unwrap()[0].path, "winner.md");
    vault
        .write("winner.md", b"unrelated\n", Some(b"archive #project\n"))
        .unwrap();
    vault.write("new.md", "量子".as_bytes(), None).unwrap();
    let hits = vault.search(&query).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "new.md");
}
