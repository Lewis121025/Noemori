//! 派生表（标题/标签/属性/全文）与磁盘同步：单篇增量、删除清理与版本重扫。

use nous_core::{SearchExpr, SearchQuery, Vault};
use std::fs;
use tempfile::TempDir;

fn vault_with(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for (name, body) in files {
        fs::write(root.path().join(name), body).expect("写夹具");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn query(expr: SearchExpr) -> SearchQuery {
    SearchQuery { expr, limit: 0 }
}

fn search_paths(vault: &Vault, terms: &[&str]) -> Vec<String> {
    vault
        .search(&query(SearchExpr::And(
            terms
                .iter()
                .map(|term| SearchExpr::Term((*term).to_string()))
                .collect(),
        )))
        .expect("检索")
        .into_iter()
        .map(|hit| hit.path)
        .collect()
}

fn open_index(index: &TempDir) -> rusqlite::Connection {
    rusqlite::Connection::open(index.path().join("index.sqlite")).expect("探测索引")
}

fn count_rows(conn: &rusqlite::Connection, table: &str, path: &str) -> i64 {
    conn.query_row(
        &format!("SELECT count(*) FROM {table} WHERE path = ?1"),
        [path],
        |row| row.get(0),
    )
    .expect("计数")
}

fn heading_rowid(conn: &rusqlite::Connection, path: &str) -> Option<i64> {
    conn.query_row(
        "SELECT rowid FROM headings WHERE path = ?1 ORDER BY idx LIMIT 1",
        [path],
        |row| row.get(0),
    )
    .ok()
}

#[test]
fn write_updates_own_rows_without_touching_sibling() {
    let (_root, index, vault) = vault_with(&[
        ("a.md", "# A\n\nfirst body\n"),
        ("b.md", "# B\n\nsibling body\n"),
    ]);
    let probe = open_index(&index);
    let sibling_row = heading_rowid(&probe, "b.md").expect("b 标题行");

    vault
        .write(
            "a.md",
            b"# A\n\nsecond body #tagged\n",
            Some(b"# A\n\nfirst body\n"),
        )
        .expect("写 a");

    assert_eq!(search_paths(&vault, &["second"]), ["a.md"]);
    assert!(search_paths(&vault, &["first"]).is_empty());
    let tagged = vault
        .search(&query(SearchExpr::Tag("tagged".to_string())))
        .expect("标签检索");
    assert_eq!(tagged.len(), 1);
    assert_eq!(tagged[0].path, "a.md");
    assert_eq!(
        heading_rowid(&probe, "b.md").expect("b 标题行"),
        sibling_row,
        "兄弟文件的派生行不应被重建"
    );
}

#[test]
fn refresh_after_external_edit_updates_search() {
    let (root, _index, vault) = vault_with(&[("a.md", "# A\n\noriginal wording\n")]);
    fs::write(root.path().join("a.md"), "# A\n\nexternal rewrite token\n").expect("外部改写");
    assert!(vault.refresh_index().expect("刷新"));
    assert_eq!(search_paths(&vault, &["external"]), ["a.md"]);
    assert!(search_paths(&vault, &["original"]).is_empty());
}

#[test]
fn deleted_file_derived_rows_are_removed() {
    let (root, index, vault) = vault_with(&[
        ("a.md", "keeper\n"),
        ("b.md", "# B Heading\n\nsibling body #doomed\n"),
    ]);
    let probe = open_index(&index);
    assert_eq!(count_rows(&probe, "tags", "b.md"), 1);

    fs::remove_file(root.path().join("b.md")).expect("删除 b");
    assert!(vault.refresh_index().expect("刷新"));

    assert!(search_paths(&vault, &["sibling"]).is_empty());
    assert_eq!(count_rows(&probe, "tags", "b.md"), 0);
    assert_eq!(count_rows(&probe, "headings", "b.md"), 0);
    assert_eq!(count_rows(&probe, "attributes", "b.md"), 0);
    assert_eq!(count_rows(&probe, "search_index", "b.md"), 0);
    assert_eq!(search_paths(&vault, &["keeper"]), ["a.md"]);
}

#[test]
fn stale_scan_version_rebuilds_derived_tables() {
    let (root, index, vault) = vault_with(&[("a.md", "# Real Title\n\nbody text\n")]);
    drop(vault);
    let conn = open_index(&index);
    conn.execute("UPDATE headings SET text = 'polluted'", [])
        .expect("污染标题");
    conn.pragma_update(None, "user_version", 0)
        .expect("旧扫描版本");
    drop(conn);

    let vault = Vault::open(root.path(), index.path()).expect("重开");
    let headings = vault.headings("a.md").expect("标题");
    assert_eq!(headings.len(), 1);
    assert_eq!(headings[0].text, "Real Title");
}

#[test]
fn missing_derived_table_rebuilds_without_losing_others() {
    let (root, index, vault) = vault_with(&[("a.md", "# A\n\nbody #kept\n")]);
    drop(vault);
    let conn = open_index(&index);
    conn.execute("DROP TABLE tags", []).expect("删表");
    drop(conn);

    let vault = Vault::open(root.path(), index.path()).expect("重开");
    let tagged = vault
        .search(&query(SearchExpr::Tag("kept".to_string())))
        .expect("标签检索");
    assert_eq!(tagged.len(), 1);
    assert_eq!(tagged[0].path, "a.md");
    let hits = vault
        .search(&query(SearchExpr::Term("body".to_string())))
        .expect("全文检索");
    assert_eq!(hits.len(), 1);
}

#[test]
fn refresh_without_disk_change_does_not_rewrite_sqlite() {
    let (_root, index, vault) = vault_with(&[("a.md", "# A\n\nbody #tag\n")]);
    let probe = open_index(&index);
    let before: i64 = probe
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .expect("data_version");
    assert!(!vault.refresh_index().expect("无变更刷新"));
    let after: i64 = probe
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .expect("data_version");
    assert_eq!(before, after, "磁盘没变就不该改索引");
}
