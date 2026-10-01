//! 批次复用实时快照，但每项独立提交；任何退出路径都保留真实完成数并收尾索引。

use noemori_vault::{EntryMutation, Error, Vault};
use rusqlite::Connection;
use std::fs;
use tempfile::TempDir;

fn setup() -> (TempDir, TempDir, Vault, Vec<EntryMutation>) {
    let root = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    fs::create_dir(root.path().join("archive")).unwrap();
    for (path, text) in [
        ("a.md", "[b](./b.md)\n"),
        ("b.md", "[c](./c.md)\n"),
        ("c.md", "[[a]]\n"),
    ] {
        fs::write(root.path().join(path), text).unwrap();
    }
    let vault = Vault::open(root.path(), state.path()).unwrap();
    let changes = ["a.md", "b.md", "c.md"]
        .into_iter()
        .map(|path| EntryMutation {
            from: path.into(),
            to: Some(format!("archive/{path}")),
        })
        .collect();
    (root, state, vault, changes)
}

#[test]
fn batch_reuses_committed_bytes_and_refreshes_the_index_once() {
    let (root, state, vault, changes) = setup();
    let index = Connection::open(state.path().join("index.sqlite")).unwrap();
    index.execute_batch("CREATE TABLE refresh_audit(path TEXT); CREATE TRIGGER count_refresh AFTER DELETE ON files BEGIN INSERT INTO refresh_audit VALUES (OLD.path); END;").unwrap();
    let mut progress = Vec::new();
    let result = vault
        .rename_batch(&changes, |completed| {
            progress.push(completed);
            if completed > 0 {
                assert!(root
                    .path()
                    .join(changes[completed - 1].to.as_ref().unwrap())
                    .exists());
            }
            Ok(true)
        })
        .unwrap();
    assert_eq!(progress, [0, 1, 2, 3]);
    assert_eq!(result.completed, 3);
    assert!(result.issue.is_none());
    assert!(result.warning.is_none());
    assert_eq!(vault.read("archive/a.md").unwrap(), b"[b](./b.md)\n");
    assert_eq!(vault.read("archive/b.md").unwrap(), b"[c](./c.md)\n");
    let rows: i64 = index
        .query_row("SELECT count(*) FROM refresh_audit", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 3);
    drop(vault);
    let reopened = Vault::open(root.path(), state.path()).unwrap();
    for path in ["a.md", "b.md", "c.md"] {
        assert_eq!(
            reopened.links_to(&format!("archive/{path}")).unwrap().len(),
            1
        );
    }
}

#[test]
fn late_preflight_conflict_prevents_the_entire_batch() {
    let (root, _state, vault, changes) = setup();
    fs::write(root.path().join("archive/c.md"), "outside").unwrap();
    assert!(vault
        .rename_batch(&changes, |_| panic!("预检未通过不能进入执行"))
        .is_err());
    for change in changes {
        assert!(root.path().join(change.from).exists());
    }
    assert!(!root.path().join("archive/a.md").exists());
}

#[test]
fn stop_before_the_first_commit_leaves_files_and_index_untouched() {
    let (root, state, vault, changes) = setup();
    let index = Connection::open(state.path().join("index.sqlite")).unwrap();
    index.execute_batch("CREATE TRIGGER reject_refresh BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'must not refresh'); END;").unwrap();
    let result = vault
        .rename_batch(&changes, |completed| {
            assert_eq!(completed, 0);
            Ok(false)
        })
        .unwrap();
    assert_eq!(result.completed, 0);
    assert!(result.issue.is_none());
    assert!(result.warning.is_none());
    for change in changes {
        assert!(root.path().join(change.from).exists());
    }
}

#[test]
fn folder_then_link_target_preserves_hidden_binary_and_invalid_utf8_contents() {
    let root = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    fs::create_dir_all(root.path().join("group/.hidden/empty")).unwrap();
    fs::create_dir(root.path().join("archive")).unwrap();
    for (path, bytes) in [
        ("group/a.md", b"[b](../b.md)\n".as_slice()),
        ("b.md", b"[a](./group/a.md)\n".as_slice()),
        ("group/.hidden/data", &[0, 255, 1]),
        ("group/invalid.md", &[255, 0]),
        ("group/image.png", &[0, 1, 2]),
    ] {
        fs::write(root.path().join(path), bytes).unwrap();
    }
    let vault = Vault::open(root.path(), state.path()).unwrap();
    let changes = ["group", "b.md"].map(|path| EntryMutation {
        from: path.into(),
        to: Some(format!("archive/{path}")),
    });
    let result = vault.rename_batch(&changes, |_| Ok(true)).unwrap();
    assert_eq!(result.completed, 2);
    assert!(result.issue.is_none());
    assert!(result.warning.is_none());
    assert_eq!(vault.read("archive/group/a.md").unwrap(), b"[b](../b.md)\n");
    assert_eq!(vault.read("archive/b.md").unwrap(), b"[a](./group/a.md)\n");
    assert_eq!(
        vault.read("archive/group/.hidden/data").unwrap(),
        [0, 255, 1]
    );
    assert_eq!(vault.read("archive/group/invalid.md").unwrap(), [255, 0]);
    assert_eq!(vault.read("archive/group/image.png").unwrap(), [0, 1, 2]);
    assert!(root.path().join("archive/group/.hidden/empty").is_dir());
    assert_eq!(vault.links_to("archive/group/a.md").unwrap().len(), 1);
    assert_eq!(vault.links_to("archive/b.md").unwrap().len(), 1);
}

#[test]
fn stop_finishes_indexing_and_retry_only_moves_the_remaining_items() {
    let (_root, _state, vault, changes) = setup();
    let stopped = vault
        .rename_batch(&changes, |completed| Ok(completed < 1))
        .unwrap();
    assert_eq!(stopped.completed, 1);
    assert!(stopped.issue.is_none());
    assert_eq!(vault.links_to("archive/a.md").unwrap().len(), 1);
    assert_eq!(
        vault.links_from("archive/a.md").unwrap()[0]
            .to_path
            .as_deref(),
        Some("b.md")
    );
    let retried = vault
        .rename_batch(&changes[stopped.completed..], |_| Ok(true))
        .unwrap();
    assert_eq!(retried.completed, 2);
    assert!(retried.issue.is_none());
    assert_eq!(vault.read("archive/a.md").unwrap(), b"[b](./b.md)\n");
}

#[test]
fn unchanged_timestamp_external_edit_stops_before_overwriting_and_updates_index() {
    let (root, _state, vault, changes) = setup();
    let result = vault
        .rename_batch(&changes, |completed| {
            if completed == 1 {
                let path = root.path().join("b.md");
                let modified = fs::metadata(&path).unwrap().modified().unwrap();
                // 等长、同时间戳的外部编辑不能被共享快照或收尾索引跳过。
                fs::write(&path, "[a](./a.md)\n").unwrap();
                fs::File::options()
                    .write(true)
                    .open(path)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(modified))
                    .unwrap();
            }
            Ok(true)
        })
        .unwrap();
    assert_eq!(result.completed, 1);
    assert!(result.issue.is_some());
    assert_eq!(vault.read("b.md").unwrap(), b"[a](./a.md)\n");
    assert!(!root.path().join("archive/b.md").exists());
    assert_eq!(vault.links_from("b.md").unwrap()[0].to_raw, "./a.md");
    assert_eq!(vault.links_to("c.md").unwrap().len(), 0);
}

#[test]
fn external_file_set_change_stops_the_next_item() {
    let (root, _state, vault, changes) = setup();
    let result = vault
        .rename_batch(&changes, |completed| {
            if completed == 1 {
                fs::write(root.path().join("outside.md"), "[[b]]\n").unwrap();
            }
            Ok(true)
        })
        .unwrap();
    assert_eq!(result.completed, 1);
    assert!(result.issue.unwrap().message.contains("集合"));
    assert_eq!(vault.read("outside.md").unwrap(), b"[[b]]\n");
    assert_eq!(vault.links_to("b.md").unwrap().len(), 2);
}

#[test]
fn callback_failure_preserves_completed_count_and_finishes_indexing() {
    let (_root, _state, vault, changes) = setup();
    let result = vault
        .rename_batch(&changes, |completed| {
            if completed == 1 {
                return Err(Error::Io(std::io::Error::other("observer failed")));
            }
            Ok(true)
        })
        .unwrap();
    assert_eq!(result.completed, 1);
    assert!(result.issue.unwrap().message.contains("observer failed"));
    assert_eq!(vault.links_to("archive/a.md").unwrap().len(), 1);
    vault.rename_batch(&changes[1..], |_| Ok(true)).unwrap();
}

#[test]
fn middle_commit_failure_keeps_prior_items_and_rolls_back_only_the_current_item() {
    let (root, state, vault, changes) = setup();
    let recovery = Connection::open(state.path().join("recovery.sqlite")).unwrap();
    recovery.execute_batch("CREATE TRIGGER reject_second BEFORE UPDATE OF committed ON rename_operation WHEN OLD.from_path = 'b.md' BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END;").unwrap();
    let result = vault.rename_batch(&changes, |_| Ok(true)).unwrap();
    assert_eq!(result.completed, 1);
    assert_eq!(result.issue.unwrap().path, "b.md");
    assert!(root.path().join("archive/a.md").exists());
    assert!(!root.path().join("archive/b.md").exists());
    assert_eq!(vault.read("b.md").unwrap(), b"[c](./c.md)\n");
    assert_eq!(vault.read("archive/a.md").unwrap(), b"[b](../b.md)\n");
    assert_eq!(vault.links_to("b.md").unwrap().len(), 1);
    let pending: i64 = recovery
        .query_row("SELECT count(*) FROM rename_operation", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(pending, 0);
}

#[test]
fn final_index_failure_is_a_warning_for_committed_items() {
    let (root, state, vault, changes) = setup();
    let index = Connection::open(state.path().join("index.sqlite")).unwrap();
    index.execute_batch("CREATE TRIGGER reject_refresh BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'injected index failure'); END;").unwrap();
    let result = vault.rename_batch(&changes, |_| Ok(true)).unwrap();
    assert_eq!(result.completed, 3);
    assert!(result.issue.is_none());
    assert!(result.warning.unwrap().contains("索引"));
    for change in changes {
        assert!(root.path().join(change.to.unwrap()).exists());
    }
    index.execute_batch("DROP TRIGGER reject_refresh;").unwrap();
    drop(vault);
    let reopened = Vault::open(root.path(), state.path()).unwrap();
    assert_eq!(reopened.links_to("archive/b.md").unwrap().len(), 1);
}
