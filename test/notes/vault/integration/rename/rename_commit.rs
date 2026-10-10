//! 在暂存与正式替换之间注入真实磁盘变化，验证分组持久化不能放宽版本校验。

use super::{apply_rename, install_version, stage_version};
use crate::rename::journal::{FileChange, RenameJournal};
use crate::storage::recovery::RecoveryStore;
use crate::Error;
use std::collections::BTreeSet;
use std::fs;
use tempfile::TempDir;

fn change(before: Option<&[u8]>, after: Option<&[u8]>) -> FileChange {
    FileChange {
        path: "note.md".into(),
        before: before.map(<[u8]>::to_vec),
        after: after.map(<[u8]>::to_vec),
        permissions: 0o600,
        started: false,
    }
}

#[test]
fn failed_step_cancellation_preserves_the_original_conflict_and_pending_journal() {
    let root = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let path = root.path().join("note.md");
    fs::write(root.path().join("source.md"), b"before").unwrap();
    fs::write(&path, b"[source](./source.md)").unwrap();
    let mut destination = change(None, Some(b"before"));
    destination.path = "moved.md".into();
    let backlink = change(
        Some(b"[source](./source.md)"),
        Some(b"[source](./moved.md)"),
    );
    let mut source = change(Some(b"before"), None);
    source.path = "source.md".into();
    let journal = RenameJournal {
        from: "source.md".into(),
        to: "moved.md".into(),
        committed: false,
        changes: vec![destination, backlink, source],
        directories: Vec::new(),
        created_directories: BTreeSet::new(),
    };
    let store = RecoveryStore::open(&state.path().join("recovery.sqlite")).unwrap();
    store.prepare_rename(&journal).unwrap();
    {
        let connection = store.lock().unwrap();
        // 在步骤标记落盘时修改正文，稳定命中暂存完成与正式替换之间的校验边界。
        connection
            .create_scalar_function(
                "external_edit",
                0,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |_| {
                    fs::write(&path, b"external")
                        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
                    Ok(0_i64)
                },
            )
            .unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER change_note AFTER UPDATE OF started ON rename_steps
             WHEN NEW.ordinal = 1 AND NEW.started = 1 BEGIN SELECT external_edit(); END;
             CREATE TRIGGER reject_cancel BEFORE UPDATE OF started ON rename_steps
             WHEN NEW.started = 0 BEGIN SELECT RAISE(ABORT, 'injected cancel failure'); END;",
            )
            .unwrap();
    }

    let error = apply_rename(root.path(), &store, &journal).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("文件已被外部修改"), "{message}");
    assert!(message.contains("note.md"), "{message}");
    assert!(message.contains("injected cancel failure"), "{message}");
    let pending = store.load_rename().unwrap().unwrap();
    assert!(!pending.committed);
    assert!(pending.changes[0].started);
    assert!(pending.changes[1].started);
    assert!(!pending.changes[2].started);
    assert_eq!(fs::read(root.path().join("note.md")).unwrap(), b"external");
    assert_eq!(fs::read(root.path().join("source.md")).unwrap(), b"before");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);

    // 外部冲突解决后，保留的日志仍能撤销先前步骤，不把失败事务误报为已提交。
    fs::write(root.path().join("note.md"), b"[source](./source.md)").unwrap();
    crate::rename::recover_pending(root.path(), &store).unwrap();
    assert!(!root.path().join("moved.md").exists());
    assert!(store.load_rename().unwrap().is_none());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn a_conflict_during_group_staging_cleans_temporary_files_without_starting_any_step() {
    let root = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    fs::write(root.path().join("source.md"), b"before").unwrap();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    let mut destination = change(None, Some(b"before"));
    destination.path = "moved.md".into();
    let conflicting = change(
        Some(b"[source](./source.md)"),
        Some(b"[source](./moved.md)"),
    );
    let mut source = change(Some(b"before"), None);
    source.path = "source.md".into();
    let journal = RenameJournal {
        from: "source.md".into(),
        to: "moved.md".into(),
        committed: false,
        changes: vec![destination, conflicting, source],
        directories: Vec::new(),
        created_directories: BTreeSet::new(),
    };
    let store = RecoveryStore::open(&state.path().join("recovery.sqlite")).unwrap();
    store.prepare_rename(&journal).unwrap();
    assert!(matches!(
        apply_rename(root.path(), &store, &journal),
        Err(Error::FileChanged { .. })
    ));
    let pending = store.load_rename().unwrap().unwrap();
    assert!(!pending.committed);
    assert!(pending.changes.iter().all(|change| !change.started));
    assert_eq!(fs::read(root.path().join("source.md")).unwrap(), b"before");
    assert_eq!(fs::read(root.path().join("note.md")).unwrap(), b"external");
    assert!(!root.path().join("moved.md").exists());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn staged_content_does_not_replace_the_note_until_installation() {
    let root = TempDir::new().unwrap();
    fs::write(root.path().join("note.md"), b"before").unwrap();
    let change = change(Some(b"before"), Some(b"after"));
    let staged = stage_version(
        root.path(),
        &change,
        change.before.as_deref(),
        change.after.as_deref(),
    )
    .unwrap();
    assert_eq!(fs::read(root.path().join("note.md")).unwrap(), b"before");
    staged.file().unwrap().sync_all().unwrap();
    install_version(root.path(), &change, change.before.as_deref(), staged).unwrap();
    assert_eq!(fs::read(root.path().join("note.md")).unwrap(), b"after");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn same_timestamp_external_edit_after_staging_is_preserved_and_temporary_file_removed() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("note.md");
    fs::write(&path, b"before").unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let change = change(Some(b"before"), Some(b"after"));
    let staged = stage_version(
        root.path(),
        &change,
        change.before.as_deref(),
        change.after.as_deref(),
    )
    .unwrap();
    staged.file().unwrap().sync_all().unwrap();
    fs::write(&path, b"edited").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert!(matches!(
        install_version(root.path(), &change, change.before.as_deref(), staged),
        Err(Error::FileChanged { .. })
    ));
    assert_eq!(fs::read(path).unwrap(), b"edited");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn newly_created_destination_after_staging_is_never_overwritten() {
    let root = TempDir::new().unwrap();
    let change = change(None, Some(b"moved"));
    let staged = stage_version(root.path(), &change, None, change.after.as_deref()).unwrap();
    staged.file().unwrap().sync_all().unwrap();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    assert!(matches!(
        install_version(root.path(), &change, None, staged),
        Err(Error::FileChanged { .. })
    ));
    assert_eq!(fs::read(root.path().join("note.md")).unwrap(), b"external");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn source_edited_after_staging_is_not_removed() {
    let root = TempDir::new().unwrap();
    let change = change(Some(b"before"), None);
    fs::write(root.path().join("note.md"), b"before").unwrap();
    let staged = stage_version(root.path(), &change, change.before.as_deref(), None).unwrap();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    assert!(matches!(
        install_version(root.path(), &change, change.before.as_deref(), staged),
        Err(Error::FileChanged { .. })
    ));
    assert_eq!(fs::read(root.path().join("note.md")).unwrap(), b"external");
}

#[cfg(unix)]
#[test]
fn replaced_parent_symlink_after_staging_cannot_redirect_installation_outside_the_vault() {
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::create_dir(root.path().join("folder")).unwrap();
    let mut change = change(Some(b"before"), Some(b"after"));
    change.path = "folder/note.md".into();
    fs::write(root.path().join(&change.path), b"before").unwrap();
    fs::write(outside.path().join("note.md"), b"before").unwrap();
    let staged = stage_version(
        root.path(),
        &change,
        change.before.as_deref(),
        change.after.as_deref(),
    )
    .unwrap();
    staged.file().unwrap().sync_all().unwrap();
    fs::rename(root.path().join("folder"), root.path().join("original")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("folder")).unwrap();
    assert!(matches!(
        install_version(root.path(), &change, change.before.as_deref(), staged),
        Err(Error::PathEscape)
    ));
    assert_eq!(fs::read(outside.path().join("note.md")).unwrap(), b"before");
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    assert_eq!(
        fs::read(root.path().join("original/note.md")).unwrap(),
        b"before"
    );
}
