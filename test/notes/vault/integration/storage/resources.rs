//! 资源契约直接观察数据库写入；最终查询结果相同不能证明没有整表重写。

use std::fs;
use std::time::{Duration, SystemTime};

use nous_vault::Vault;
use rusqlite::Connection;
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
    _index: TempDir,
    vault: Vault,
    probe: Connection,
}

impl Fixture {
    fn new(siblings: usize) -> Self {
        let root = TempDir::new().unwrap();
        let index = TempDir::new().unwrap();
        fs::write(root.path().join("edit.md"), "# Original\n\nold [[keep]]\n").unwrap();
        fs::write(root.path().join("keep.md"), "# Keep\n\n[[keep]]\n").unwrap();
        fs::write(root.path().join("ref.md"), "[[Original]] [[Renamed]]\n").unwrap();
        for number in 0..siblings {
            fs::write(
                root.path().join(format!("sibling-{number}.md")),
                format!("# Sibling {number}\n\n[[keep]] #tag\n"),
            )
            .unwrap();
        }
        let vault = Vault::open(root.path(), index.path()).unwrap();
        let probe = Connection::open(index.path().join("index.sqlite")).unwrap();
        probe
            .execute_batch(
                "CREATE TABLE observed_writes (table_name TEXT, operation TEXT, path TEXT);",
            )
            .unwrap();
        for table in [
            "files",
            "links",
            "headings",
            "tags",
            "attributes",
            "search_sources",
        ] {
            let path_column = if table == "links" {
                "from_path"
            } else {
                "path"
            };
            for (operation, row) in [("INSERT", "new"), ("UPDATE", "new"), ("DELETE", "old")] {
                probe.execute_batch(&format!(
                    "CREATE TRIGGER observe_{table}_{operation} AFTER {operation} ON {table}
                     BEGIN INSERT INTO observed_writes VALUES ('{table}', '{operation}', {row}.{path_column}); END;"
                )).unwrap();
            }
        }
        Self {
            root,
            _index: index,
            vault,
            probe,
        }
    }

    fn writes(&self) -> Vec<(String, String, String)> {
        self.probe
            .prepare("SELECT table_name, operation, path FROM observed_writes ORDER BY table_name, operation, path")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn rewrite(&self, body: &str) {
        let path = self.root.path().join("edit.md");
        fs::write(&path, body).unwrap();
        // 明确改变时间戳，避免快速测试受文件系统时间分辨率影响。
        fs::File::open(path)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(2))
            .unwrap();
    }
}

#[test]
fn resource_idle_refresh_does_not_write_index_rows() {
    let fixture = Fixture::new(8);
    for _ in 0..20 {
        assert!(!fixture.vault.refresh_index().unwrap());
    }
    assert!(fixture.writes().is_empty());
}

#[test]
fn resource_external_body_edit_writes_only_its_document_at_every_vault_size() {
    let mut counts = Vec::new();
    for size in [8, 512] {
        let fixture = Fixture::new(size);
        fixture.rewrite("# Original\n\nnew text [[keep]] #newtag\n");
        assert!(fixture.vault.refresh_index().unwrap());
        let writes = fixture.writes();
        assert!(!writes.is_empty());
        let unrelated: Vec<_> = writes
            .iter()
            .filter(|(_, _, path)| path != "edit.md")
            .collect();
        assert!(
            unrelated.is_empty(),
            "局部正文更新重写了无关记录：{unrelated:?}"
        );
        counts.push(writes.len());
        assert_eq!(
            fixture.vault.links_from("edit.md").unwrap()[0]
                .to_path
                .as_deref(),
            Some("keep.md")
        );
    }
    assert_eq!(counts[0], counts[1], "固定修改的写入行数不能随库规模增长");
}

#[test]
fn resource_timestamp_only_change_does_not_rebuild_content_or_links() {
    let fixture = Fixture::new(8);
    fixture.rewrite("# Original\n\nold [[keep]]\n");
    assert!(fixture.vault.refresh_index().unwrap());
    assert_eq!(
        fixture.writes(),
        [("files".into(), "UPDATE".into(), "edit.md".into())]
    );
}

#[test]
fn resource_identity_changes_rebind_only_affected_sources_for_internal_and_external_writes() {
    for external in [false, true] {
        let fixture = Fixture::new(8);
        let body = "# Renamed\n\nold [[keep]]\n";
        if external {
            fixture.rewrite(body);
            fixture.vault.refresh_index().unwrap();
        } else {
            fixture
                .vault
                .write(
                    "edit.md",
                    body.as_bytes(),
                    Some(b"# Original\n\nold [[keep]]\n"),
                )
                .unwrap();
        }
        let links = fixture.vault.links_from("ref.md").unwrap();
        assert!(links
            .iter()
            .any(|link| link.to_raw == "Original" && link.to_path.is_none()));
        assert!(links
            .iter()
            .any(|link| link.to_raw == "Renamed" && link.to_path.as_deref() == Some("edit.md")));
        let writes = fixture.writes();
        let unrelated: Vec<_> = writes
            .iter()
            .filter(|(_, _, path)| path != "edit.md" && path != "ref.md")
            .collect();
        assert!(
            unrelated.is_empty(),
            "身份变化重写了无关记录：{unrelated:?}"
        );
    }
}

#[test]
fn resource_failed_refresh_rolls_back_every_observed_write_and_can_retry() {
    let fixture = Fixture::new(8);
    fixture.probe.execute_batch(
        "CREATE TRIGGER reject_new_heading BEFORE INSERT ON headings BEGIN SELECT RAISE(ABORT, 'injected'); END;"
    ).unwrap();
    fixture.rewrite("# Renamed\n\nnew body\n");
    assert!(fixture.vault.refresh_index().is_err());
    assert!(fixture.writes().is_empty(), "失败事务不能发布部分写入");
    fixture
        .probe
        .execute_batch("DROP TRIGGER reject_new_heading")
        .unwrap();
    assert!(fixture.vault.refresh_index().unwrap());
    assert!(!fixture.writes().is_empty());
}
