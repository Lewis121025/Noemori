use noemori_vault::{Vault, WriteOutcome};
use std::fs;
use std::sync::{Arc, Barrier};
use tempfile::TempDir;

fn setup() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("note.md"), b"base").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    (root, index, vault)
}

#[test]
fn external_edit_is_not_overwritten_by_autosave() {
    let (root, index, vault) = setup();
    let base = vault.read("note.md").unwrap();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    let result = vault.write("note.md", b"my edits", Some(&base)).unwrap();
    assert!(matches!(result, WriteOutcome::Conflict { disk: Some(bytes) } if bytes == b"external"));
    assert_eq!(vault.read("note.md").unwrap(), b"external");
    drop(vault);

    let reopened = Vault::open(root.path(), index.path()).unwrap();
    let snapshot = reopened.snapshot("note.md").unwrap();
    let draft = snapshot.draft.unwrap();
    assert_eq!(draft.bytes, b"my edits");
    assert_eq!(draft.base, Some(base));
    assert_eq!(snapshot.disk.unwrap(), b"external");
}

#[test]
fn deleted_file_remains_deleted_and_its_draft_is_discoverable_after_restart() {
    let (root, index, vault) = setup();
    fs::remove_file(root.path().join("note.md")).unwrap();
    assert!(matches!(
        vault.write("note.md", b"my edits", Some(b"base")).unwrap(),
        WriteOutcome::Conflict { disk: None }
    ));
    assert!(!root.path().join("note.md").exists());
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(reopened.list_files().unwrap(), vec!["note.md"]);
    let snapshot = reopened.snapshot("note.md").unwrap();
    assert!(snapshot.disk.is_none());
    assert_eq!(snapshot.draft.unwrap().bytes, b"my edits");
}

#[test]
fn io_failure_keeps_latest_draft_and_retry_clears_it() {
    let (root, index, vault) = setup();
    fs::remove_file(root.path().join("note.md")).unwrap();
    fs::create_dir(root.path().join("note.md")).unwrap();
    assert!(vault
        .write("note.md", b"latest edits", Some(b"base"))
        .is_err());
    fs::remove_dir(root.path().join("note.md")).unwrap();
    fs::write(root.path().join("note.md"), b"base").unwrap();
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(
        reopened.snapshot("note.md").unwrap().draft.unwrap().bytes,
        b"latest edits"
    );
    assert!(matches!(
        reopened
            .write("note.md", b"latest edits", Some(b"base"))
            .unwrap(),
        WriteOutcome::Saved { warning: None }
    ));
    assert!(reopened.snapshot("note.md").unwrap().draft.is_none());
    assert_eq!(reopened.read("note.md").unwrap(), b"latest edits");
}

#[test]
fn blocked_parent_preserves_the_latest_edit_before_reporting_the_disk_error() {
    let (root, index, vault) = setup();
    fs::create_dir(root.path().join("folder")).unwrap();
    fs::write(root.path().join("folder/note.md"), b"base").unwrap();
    fs::remove_dir_all(root.path().join("folder")).unwrap();
    fs::write(root.path().join("folder"), b"external file").unwrap();

    assert!(vault
        .write("folder/note.md", b"latest edits", Some(b"base"))
        .is_err());
    assert_eq!(
        fs::read(root.path().join("folder")).unwrap(),
        b"external file"
    );
    drop(vault);
    fs::remove_file(root.path().join("folder")).unwrap();
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(
        reopened
            .snapshot("folder/note.md")
            .unwrap()
            .draft
            .unwrap()
            .bytes,
        b"latest edits"
    );
}

#[test]
fn draft_remains_readable_when_its_parent_is_replaced_by_a_file() {
    let (root, index, vault) = setup();
    fs::create_dir(root.path().join("folder")).unwrap();
    fs::write(root.path().join("folder/note.md"), b"external").unwrap();
    vault
        .write("folder/note.md", b"draft", Some(b"base"))
        .unwrap();
    fs::remove_dir_all(root.path().join("folder")).unwrap();
    fs::write(root.path().join("folder"), b"external file").unwrap();
    drop(vault);

    let reopened = Vault::open(root.path(), index.path()).unwrap();
    let snapshot = reopened.snapshot("folder/note.md").unwrap();
    assert!(snapshot.disk.is_none());
    assert!(snapshot.disk_error.is_some());
    assert_eq!(snapshot.draft.unwrap().bytes, b"draft");
    let entries = reopened.list_entries().unwrap();
    assert!(entries
        .iter()
        .any(|entry| entry.path == "folder/note.md" && entry.recovery_only));
    assert!(entries
        .iter()
        .any(|entry| entry.path == "folder" && !entry.recovery_only));
    let copy = reopened
        .write_copy("folder/note.md", b"latest draft", Some(b"base"))
        .unwrap();
    assert_eq!(copy.path, "note (副本).md");
    assert_eq!(reopened.read(&copy.path).unwrap(), b"latest draft");
    assert_eq!(
        fs::read(root.path().join("folder")).unwrap(),
        b"external file"
    );
    assert!(copy
        .warning
        .as_deref()
        .is_some_and(|message| message.contains("根目录")));
}

#[test]
fn draft_remains_readable_when_its_file_is_replaced_by_a_directory() {
    let (root, index, vault) = setup();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    vault.write("note.md", b"draft", Some(b"base")).unwrap();
    fs::remove_file(root.path().join("note.md")).unwrap();
    fs::create_dir(root.path().join("note.md")).unwrap();
    fs::write(root.path().join("note.md/child.txt"), b"keep child").unwrap();
    drop(vault);

    let reopened = Vault::open(root.path(), index.path()).unwrap();
    let snapshot = reopened.snapshot("note.md").unwrap();
    assert!(snapshot.disk.is_none());
    assert!(snapshot.disk_error.is_some());
    assert_eq!(snapshot.draft.unwrap().bytes, b"draft");
    let entries = reopened.list_entries().unwrap();
    assert!(entries
        .iter()
        .any(|entry| entry.path == "note.md" && entry.recovery_only));
    assert!(entries.iter().any(|entry| entry.path == "note.md"
        && entry.kind == noemori_vault::EntryKind::Directory
        && !entry.recovery_only));
    let copy = reopened
        .write_copy("note.md", b"latest draft", Some(b"base"))
        .unwrap();
    assert_eq!(reopened.read(&copy.path).unwrap(), b"latest draft");
    assert_eq!(
        fs::read(root.path().join("note.md/child.txt")).unwrap(),
        b"keep child"
    );
    assert!(reopened.snapshot("note.md").is_err());
}

#[cfg(unix)]
#[test]
fn changed_parent_symlink_cannot_expose_or_overwrite_external_files_during_recovery() {
    use std::os::unix::fs::symlink;
    let (root, index, vault) = setup();
    let outside = TempDir::new().unwrap();
    fs::create_dir(root.path().join("folder")).unwrap();
    fs::write(root.path().join("folder/note.md"), b"base").unwrap();
    fs::write(outside.path().join("note.md"), b"external private content").unwrap();
    fs::remove_dir_all(root.path().join("folder")).unwrap();
    symlink(outside.path(), root.path().join("folder")).unwrap();
    assert!(vault
        .write("folder/note.md", b"recover these edits", Some(b"base"))
        .is_err());
    drop(vault);

    let reopened = Vault::open(root.path(), index.path()).unwrap();
    let snapshot = reopened.snapshot("folder/note.md").unwrap();
    assert!(snapshot.disk.is_none());
    assert!(snapshot.disk_error.is_some());
    assert_eq!(snapshot.draft.unwrap().bytes, b"recover these edits");
    let copy = reopened
        .write_copy("folder/note.md", b"latest edits", Some(b"base"))
        .unwrap();
    assert_eq!(copy.path, "note (副本).md");
    assert_eq!(reopened.read(&copy.path).unwrap(), b"latest edits");
    assert_eq!(
        fs::read(outside.path().join("note.md")).unwrap(),
        b"external private content"
    );
    assert!(!outside.path().join("note (副本).md").exists());
}

#[cfg(unix)]
#[test]
fn recovered_copy_is_writable_even_when_the_original_is_read_only() {
    use std::os::unix::fs::PermissionsExt;
    let (root, _index, vault) = setup();
    fs::set_permissions(
        root.path().join("note.md"),
        fs::Permissions::from_mode(0o400),
    )
    .unwrap();
    let copy = vault
        .write_copy("note.md", b"editable copy", Some(b"base"))
        .unwrap();
    assert_ne!(
        fs::metadata(root.path().join(&copy.path))
            .unwrap()
            .permissions()
            .mode()
            & 0o200,
        0
    );
    assert_eq!(vault.read("note.md").unwrap(), b"base");
}

#[cfg(unix)]
#[test]
fn copy_recovers_to_root_when_the_original_directory_becomes_read_only() {
    use std::os::unix::fs::PermissionsExt;
    let (root, _index, vault) = setup();
    let parent = root.path().join("folder");
    fs::create_dir(&parent).unwrap();
    fs::write(parent.join("note.md"), b"base").unwrap();
    fs::write(root.path().join("note (副本).md"), b"existing copy").unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o500)).unwrap();
    // 超级用户可绕过目录权限，此时无法构造本用例的操作系统前置条件。
    if tempfile::tempfile_in(&parent).is_ok() {
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!("当前用户绕过目录权限，跳过只读目录场景");
        return;
    }
    let result = vault.write_copy("folder/note.md", b"latest edits", Some(b"base"));
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();

    let copy = result.unwrap();
    assert_eq!(copy.path, "note (副本 2).md");
    assert!(copy
        .warning
        .as_deref()
        .is_some_and(|text| text.contains("根目录")));
    assert_eq!(vault.read(&copy.path).unwrap(), b"latest edits");
    assert_eq!(vault.read("folder/note.md").unwrap(), b"base");
    assert_eq!(vault.read("note (副本).md").unwrap(), b"existing copy");
    assert!(vault.snapshot("folder/note.md").unwrap().draft.is_none());
}

#[cfg(unix)]
#[test]
fn unavailable_copy_destination_keeps_the_latest_draft_for_retry() {
    use std::os::unix::fs::PermissionsExt;
    let (root, index, vault) = setup();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o500)).unwrap();
    if tempfile::tempfile_in(root.path()).is_ok() {
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!("当前用户绕过目录权限，跳过只读目录场景");
        return;
    }
    let result = vault.write_copy("note.md", b"latest edits", Some(b"base"));
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    drop(vault);

    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(
        reopened.snapshot("note.md").unwrap().draft.unwrap().bytes,
        b"latest edits"
    );
    assert_eq!(reopened.read("note.md").unwrap(), b"base");
    let copy = reopened
        .write_copy("note.md", b"latest edits", Some(b"base"))
        .unwrap();
    assert_eq!(reopened.read(&copy.path).unwrap(), b"latest edits");
    assert!(reopened.snapshot("note.md").unwrap().draft.is_none());
}

#[test]
fn index_failure_reports_committed_content_and_does_not_cause_a_false_conflict() {
    let (_root, index, vault) = setup();
    let probe = rusqlite::Connection::open(index.path().join("index.sqlite")).unwrap();
    probe.execute_batch("CREATE TRIGGER reject_update BEFORE UPDATE ON files BEGIN SELECT RAISE(ABORT, 'test index failure'); END;").unwrap();
    let saved = vault
        .write("note.md", b"first save", Some(b"base"))
        .unwrap();
    assert!(matches!(saved, WriteOutcome::Saved { warning: Some(_) }));
    assert_eq!(vault.read("note.md").unwrap(), b"first save");
    assert!(vault.snapshot("note.md").unwrap().draft.is_none());
    probe.execute_batch("DROP TRIGGER reject_update;").unwrap();
    assert!(matches!(
        vault
            .write("note.md", b"second save", Some(b"first save"))
            .unwrap(),
        WriteOutcome::Saved { warning: None }
    ));
}

#[test]
fn saving_a_copy_preserves_both_versions_and_existing_copies() {
    let (root, _index, vault) = setup();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    fs::write(root.path().join("note (副本).md"), b"older copy").unwrap();
    vault.write("note.md", b"draft", Some(b"base")).unwrap();
    let copy = vault
        .write_copy("note.md", b"newer draft", Some(b"base"))
        .unwrap();
    assert_eq!(copy.path, "note (副本 2).md");
    assert!(copy.warning.is_none());
    assert_eq!(vault.read(&copy.path).unwrap(), b"newer draft");
    assert_eq!(vault.read("note.md").unwrap(), b"external");
    assert_eq!(vault.read("note (副本).md").unwrap(), b"older copy");
    assert!(vault.snapshot("note.md").unwrap().draft.is_none());
}

#[test]
fn saving_a_copy_skips_names_reserved_by_deleted_drafts_and_their_parents() {
    let (root, _index, vault) = setup();
    for path in ["note (副本).md", "note (副本 2).md/child.md"] {
        fs::create_dir_all(root.path().join(path).parent().unwrap()).unwrap();
        fs::write(root.path().join(path), b"external").unwrap();
        vault
            .write(path, b"recoverable edits", Some(b"base"))
            .unwrap();
    }
    fs::remove_file(root.path().join("note (副本).md")).unwrap();
    fs::remove_dir_all(root.path().join("note (副本 2).md")).unwrap();

    let copy = vault
        .write_copy("note.md", b"new copy", Some(b"base"))
        .unwrap();
    assert_eq!(copy.path, "note (副本 3).md");
    assert_eq!(vault.read(&copy.path).unwrap(), b"new copy");
    for path in ["note (副本).md", "note (副本 2).md/child.md"] {
        let snapshot = vault.snapshot(path).unwrap();
        assert!(snapshot.disk.is_none());
        assert_eq!(snapshot.draft.unwrap().bytes, b"recoverable edits");
    }
}

#[test]
fn saving_cannot_replace_a_deleted_drafts_parent_with_a_file() {
    let (root, _index, vault) = setup();
    fs::create_dir(root.path().join("folder.md")).unwrap();
    fs::write(root.path().join("folder.md/child.md"), b"external").unwrap();
    vault
        .write("folder.md/child.md", b"child edits", Some(b"base"))
        .unwrap();
    fs::remove_dir_all(root.path().join("folder.md")).unwrap();

    assert!(vault.write("folder.md", b"parent file", None).is_err());
    assert!(!root.path().join("folder.md").exists());
    assert!(vault.snapshot("folder.md").unwrap().draft.is_none());
    assert_eq!(
        vault
            .snapshot("folder.md/child.md")
            .unwrap()
            .draft
            .unwrap()
            .bytes,
        b"child edits"
    );
}

#[test]
fn saving_cannot_turn_a_deleted_draft_into_a_parent_directory() {
    let (root, _index, vault) = setup();
    fs::remove_file(root.path().join("note.md")).unwrap();
    vault
        .write("note.md", b"original draft", Some(b"base"))
        .unwrap();

    assert!(vault.write("note.md/child.md", b"new child", None).is_err());
    assert!(vault
        .write_copy("note.md/child.md", b"new child", None)
        .is_err());
    assert!(!root.path().join("note.md").exists());
    assert!(vault.snapshot("note.md/child.md").unwrap().draft.is_none());
    assert_eq!(
        vault.snapshot("note.md").unwrap().draft.unwrap().bytes,
        b"original draft"
    );
}

#[test]
fn concurrent_saves_from_the_same_base_cannot_both_commit() {
    let (_root, _index, vault) = setup();
    let vault = Arc::new(vault);
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = [b"one", b"two"]
        .into_iter()
        .map(|bytes| {
            let vault = Arc::clone(&vault);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                vault.write("note.md", bytes, Some(b"base")).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, WriteOutcome::Saved { .. }))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, WriteOutcome::Conflict { .. }))
            .count(),
        1
    );
}

#[test]
fn existing_temporary_named_file_is_never_truncated() {
    let (root, _index, vault) = setup();
    fs::write(root.path().join("note.noemori-tmp"), b"valuable").unwrap();
    vault.write("note.md", b"edited", Some(b"base")).unwrap();
    assert_eq!(
        fs::read(root.path().join("note.noemori-tmp")).unwrap(),
        b"valuable"
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn missing_expected_version_cannot_replace_an_existing_file() {
    let (_root, _index, vault) = setup();
    assert!(matches!(
        vault.write("note.md", b"new", None).unwrap(),
        WriteOutcome::Conflict { .. }
    ));
    assert_eq!(vault.read("note.md").unwrap(), b"base");
}

#[test]
fn recovery_storage_failure_leaves_the_original_untouched() {
    let (_root, index, vault) = setup();
    let probe = rusqlite::Connection::open(index.path().join("recovery.sqlite")).unwrap();
    probe.execute_batch("CREATE TRIGGER reject_draft BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT, 'test recovery failure'); END;").unwrap();
    assert!(vault.write("note.md", b"edited", Some(b"base")).is_err());
    assert_eq!(vault.read("note.md").unwrap(), b"base");
}

#[test]
fn latest_conflicting_edits_replace_the_recoverable_draft() {
    let (root, index, vault) = setup();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    vault.write("note.md", b"first", Some(b"base")).unwrap();
    vault.write("note.md", b"latest", Some(b"base")).unwrap();
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(
        reopened.snapshot("note.md").unwrap().draft.unwrap().bytes,
        b"latest"
    );
    assert_eq!(reopened.read("note.md").unwrap(), b"external");
}
#[test]
fn editor_checkpoint_keeps_source_and_latest_state_without_touching_disk() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let source = "\u{feff}原文 _保留_\r\n".as_bytes();
    std::fs::write(root.path().join("note.md"), source).unwrap();
    let vault = noemori_vault::Vault::open(root.path(), index.path()).unwrap();
    vault
        .preserve_editor_draft("note.md", source, Some(source), "editor-v1-first")
        .unwrap();
    vault
        .preserve_editor_draft("note.md", source, Some(source), "editor-v1-latest")
        .unwrap();
    assert_eq!(std::fs::read(root.path().join("note.md")).unwrap(), source);
    // 原始源码与磁盘相同也必须保留，真正的最新编辑位于 editor 字段。
    let draft = vault.snapshot("note.md").unwrap().draft.unwrap();
    assert_eq!(draft.bytes, source);
    assert_eq!(draft.editor.as_deref(), Some("editor-v1-latest"));
    assert!(vault.rename("note.md", "renamed.md").is_err());
    assert!(vault
        .trash_entry("note.md", |_| panic!("未提交的恢复内容不能交给废纸篓"))
        .is_err());
    assert_eq!(
        vault
            .snapshot("note.md")
            .unwrap()
            .draft
            .unwrap()
            .editor
            .as_deref(),
        Some("editor-v1-latest")
    );
    drop(vault);
    std::fs::remove_file(root.path().join("note.md")).unwrap();
    let reopened = noemori_vault::Vault::open(root.path(), index.path()).unwrap();
    let snapshot = reopened.snapshot("note.md").unwrap();
    assert!(snapshot.disk.is_none());
    assert_eq!(
        snapshot.draft.unwrap().editor.as_deref(),
        Some("editor-v1-latest")
    );
    reopened.write("note.md", b"resolved", None).unwrap();
    assert!(reopened.snapshot("note.md").unwrap().draft.is_none());
}

#[test]
fn editor_checkpoint_migration_keeps_existing_drafts_and_recovery_tables() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let connection = rusqlite::Connection::open(index.path().join("recovery.sqlite")).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE drafts (path TEXT PRIMARY KEY, bytes BLOB NOT NULL, base BLOB);
        INSERT INTO drafts VALUES ('old.md', X'65646974', X'62617365');
        CREATE TABLE rename_created_directories (path TEXT PRIMARY KEY);
        INSERT INTO rename_created_directories VALUES ('owned');",
        )
        .unwrap();
    let vault = noemori_vault::Vault::open(root.path(), index.path()).unwrap();
    let draft = vault.snapshot("old.md").unwrap().draft.unwrap();
    assert_eq!(draft.bytes, b"edit");
    assert_eq!(draft.base.as_deref(), Some(b"base".as_slice()));
    assert!(draft.editor.is_none());
    let marker: String = connection
        .query_row("SELECT path FROM rename_created_directories", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(marker, "owned");
    vault
        .preserve_editor_draft("new.md", b"source", None, "checkpoint")
        .unwrap();
    assert_eq!(
        vault
            .snapshot("new.md")
            .unwrap()
            .draft
            .unwrap()
            .editor
            .as_deref(),
        Some("checkpoint")
    );
}

#[test]
fn failed_editor_checkpoint_preserves_previous_record_and_reports_failure() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("note.md"), b"disk").unwrap();
    let vault = noemori_vault::Vault::open(root.path(), index.path()).unwrap();
    vault
        .preserve_editor_draft("note.md", b"source", Some(b"disk"), "previous")
        .unwrap();
    let connection = rusqlite::Connection::open(index.path().join("recovery.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_update BEFORE UPDATE ON drafts BEGIN SELECT RAISE(FAIL, 'injected failure'); END;").unwrap();
    assert!(vault
        .preserve_editor_draft("note.md", b"source", Some(b"disk"), "latest")
        .is_err());
    assert_eq!(
        vault
            .snapshot("note.md")
            .unwrap()
            .draft
            .unwrap()
            .editor
            .as_deref(),
        Some("previous")
    );
    assert_eq!(std::fs::read(root.path().join("note.md")).unwrap(), b"disk");
}

#[test]
fn editor_checkpoint_rejects_invalid_paths_and_payload_without_new_records() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let vault = noemori_vault::Vault::open(root.path(), index.path()).unwrap();
    for path in ["../outside.md", "/outside.md", "image.png"] {
        assert!(vault
            .preserve_editor_draft(path, b"source", None, "editor")
            .is_err());
    }
    assert!(vault
        .preserve_editor_draft("note.md", &[0xff], None, "editor")
        .is_err());
    assert!(vault
        .preserve_editor_draft("note.md", b"source", None, "")
        .is_err());
    assert!(vault.snapshot("note.md").unwrap().draft.is_none());
}
