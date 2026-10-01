use noemori_vault::{Error, Vault};
use rusqlite::{params, Connection};
use std::fmt::Write;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn setup() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    fs::write(root.path().join("A.md"), b"[[B]]\n").unwrap();
    fs::write(root.path().join("B.md"), b"note\n").unwrap();
    fs::write(root.path().join("D.md"), b"[B](./B.md)\n").unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    (root, state, vault)
}

fn recovery(state: &TempDir) -> Connection {
    Connection::open(state.path().join("recovery.sqlite")).unwrap()
}

fn assert_original(root: &Path) {
    assert_eq!(fs::read(root.join("A.md")).unwrap(), b"[[B]]\n");
    assert_eq!(fs::read(root.join("B.md")).unwrap(), b"note\n");
    assert_eq!(fs::read(root.join("D.md")).unwrap(), b"[B](./B.md)\n");
    assert!(!root.join("C.md").exists());
    assert_eq!(fs::read_dir(root).unwrap().count(), 3);
}

fn assert_committed(root: &Path) {
    assert_eq!(fs::read(root.join("A.md")).unwrap(), b"[[C]]\n");
    assert_eq!(fs::read(root.join("D.md")).unwrap(), b"[B](./C.md)\n");
    assert_eq!(fs::read(root.join("C.md")).unwrap(), b"note\n");
    assert!(!root.join("B.md").exists());
}

fn assert_journal_cleared(state: &TempDir) {
    let count: i64 = recovery(state)
        .query_row("SELECT count(*) FROM rename_operation", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = recovery(state)
        .query_row("SELECT count(*) FROM rename_steps", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    for table in ["rename_directories", "rename_created_directories"] {
        let count: i64 = recovery(state)
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}

#[test]
fn failure_at_each_step_rolls_back_all_preceding_file_changes() {
    for ordinal in 0..4 {
        let (root, state, vault) = setup();
        recovery(&state).execute_batch(&format!("CREATE TRIGGER reject_step BEFORE UPDATE OF started ON rename_steps WHEN NEW.ordinal = {ordinal} AND NEW.started = 1 BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;")).unwrap();
        assert!(vault.rename("B.md", "C.md").is_err());
        assert_original(root.path());
        assert_journal_cleared(&state);
    }
}

#[test]
fn failure_to_record_the_plan_does_not_touch_files() {
    let (root, state, vault) = setup();
    recovery(&state).execute_batch("CREATE TRIGGER reject_plan BEFORE INSERT ON rename_steps WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'injected prepare failure'); END;").unwrap();
    assert!(vault.rename("B.md", "C.md").is_err());
    assert_original(root.path());
    assert_journal_cleared(&state);
}

#[test]
fn failure_to_commit_restores_the_deleted_source_and_every_backlink() {
    let (root, state, vault) = setup();
    recovery(&state).execute_batch("CREATE TRIGGER reject_commit BEFORE UPDATE OF committed ON rename_operation BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;").unwrap();
    assert!(vault.rename("B.md", "C.md").is_err());
    assert_original(root.path());
    assert_journal_cleared(&state);
}

#[test]
fn folder_failure_at_each_step_or_commit_restores_files_links_and_empty_directories() {
    // 两个目标文件、一个入链更新、两个源文件删除，分别验证每个边界。
    for failed_step in 0..=5 {
        let root = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("old/empty/deep")).unwrap();
        fs::write(root.path().join("old/A.md"), b"[B](../B.md)\n").unwrap();
        fs::write(root.path().join("old/.hidden"), b"hidden\0bytes").unwrap();
        fs::write(root.path().join("B.md"), b"[A](old/A.md)\n").unwrap();
        let vault = Vault::open(root.path(), state.path()).unwrap();
        let trigger = if failed_step < 5 {
            format!("CREATE TRIGGER reject_step BEFORE UPDATE OF started ON rename_steps WHEN NEW.ordinal = {failed_step} AND NEW.started = 1 BEGIN SELECT RAISE(ABORT, 'injected folder failure'); END;")
        } else {
            "CREATE TRIGGER reject_commit BEFORE UPDATE OF committed ON rename_operation BEGIN SELECT RAISE(ABORT, 'injected folder commit failure'); END;".to_string()
        };
        recovery(&state).execute_batch(&trigger).unwrap();
        assert!(vault.rename("old", "parent/new").is_err());
        assert_eq!(vault.read("old/A.md").unwrap(), b"[B](../B.md)\n");
        assert_eq!(vault.read("old/.hidden").unwrap(), b"hidden\0bytes");
        assert_eq!(vault.read("B.md").unwrap(), b"[A](old/A.md)\n");
        assert!(root.path().join("old/empty/deep").is_dir());
        assert!(!root.path().join("parent").exists());
        assert_journal_cleared(&state);
        drop(vault);
        let reopened = Vault::open(root.path(), state.path()).unwrap();
        assert_eq!(reopened.links_to("old/A.md").unwrap().len(), 1);
    }
}

#[test]
fn failure_across_multiple_staging_groups_restores_every_file_and_directory() {
    // 八个目标、一个入链更新和八个源删除跨越多组暂存；每个子目录也需要独立同步。
    for failed_step in 0..=17 {
        let root = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("old/empty/deep")).unwrap();
        let mut backlinks = String::new();
        for note in 0..8 {
            let directory = root.path().join(format!("old/{note}"));
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("note.md"), format!("note {note}\n")).unwrap();
            writeln!(backlinks, "[{note}](old/{note}/note.md)").unwrap();
        }
        fs::write(root.path().join("index.md"), &backlinks).unwrap();
        let vault = Vault::open(root.path(), state.path()).unwrap();
        let trigger = if failed_step < 17 {
            format!("CREATE TRIGGER reject_step BEFORE UPDATE OF started ON rename_steps WHEN NEW.ordinal = {failed_step} AND NEW.started = 1 BEGIN SELECT RAISE(ABORT, 'injected group failure'); END;")
        } else {
            "CREATE TRIGGER reject_commit BEFORE UPDATE OF committed ON rename_operation BEGIN SELECT RAISE(ABORT, 'injected group failure'); END;".to_string()
        };
        recovery(&state).execute_batch(&trigger).unwrap();

        let error = vault.rename("old", "parent/new").unwrap_err();
        assert!(error.to_string().contains("injected group failure"));
        for note in 0..8 {
            let path = format!("old/{note}/note.md");
            assert_eq!(
                vault.read(&path).unwrap(),
                format!("note {note}\n").as_bytes()
            );
            assert_eq!(
                fs::read_dir(root.path().join(format!("old/{note}")))
                    .unwrap()
                    .count(),
                1
            );
        }
        assert_eq!(vault.read("index.md").unwrap(), backlinks.as_bytes());
        assert!(root.path().join("old/empty/deep").is_dir());
        assert!(!root.path().join("parent").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
        assert_eq!(fs::read_dir(root.path().join("old")).unwrap().count(), 9);
        assert_journal_cleared(&state);
        drop(vault);
        let reopened = Vault::open(root.path(), state.path()).unwrap();
        for note in 0..8 {
            assert_eq!(
                reopened
                    .links_to(&format!("old/{note}/note.md"))
                    .unwrap()
                    .len(),
                1
            );
        }
    }
}

#[test]
fn index_failure_keeps_a_committed_rename_and_reports_a_warning() {
    let (root, state, vault) = setup();
    let index = Connection::open(state.path().join("index.sqlite")).unwrap();
    index.execute_batch("CREATE TRIGGER reject_index BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'injected index failure'); END;").unwrap();
    let result = vault.rename("B.md", "C.md").unwrap();
    assert!(result.warning.unwrap().contains("索引"));
    assert_committed(root.path());
    assert_journal_cleared(&state);
    index.execute_batch("DROP TRIGGER reject_index;").unwrap();
    drop(vault);
    let reopened = Vault::open(root.path(), state.path()).unwrap();
    assert_eq!(reopened.links_to("C.md").unwrap().len(), 2);
}

#[test]
fn cleanup_failure_does_not_undo_a_committed_rename_on_restart() {
    let (root, state, vault) = setup();
    let conn = recovery(&state);
    conn.execute_batch("CREATE TRIGGER reject_cleanup BEFORE DELETE ON rename_operation BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;").unwrap();
    let result = vault.rename("B.md", "C.md").unwrap();
    assert!(result.warning.unwrap().contains("清理"));
    assert_committed(root.path());
    fs::write(root.path().join("C.md"), b"external after commit").unwrap();
    conn.execute_batch("DROP TRIGGER reject_cleanup;").unwrap();
    drop(vault);
    Vault::open(root.path(), state.path()).unwrap();
    assert_eq!(
        fs::read(root.path().join("C.md")).unwrap(),
        b"external after commit"
    );
    assert!(!root.path().join("B.md").exists());
    assert_journal_cleared(&state);
}

// 模拟进程在日志已同步、某个文件替换前后退出的磁盘状态。
fn interrupted(root: &Path, state: &TempDir, applied: usize, next_started: bool) {
    type Change<'a> = (&'a str, Option<&'a [u8]>, Option<&'a [u8]>);
    let changes: [Change<'_>; 4] = [
        ("C.md", None, Some(b"note\n")),
        ("A.md", Some(b"[[B]]\n"), Some(b"[[C]]\n")),
        ("D.md", Some(b"[B](./B.md)\n"), Some(b"[B](./C.md)\n")),
        ("B.md", Some(b"note\n"), None),
    ];
    let mut conn = recovery(state);
    let tx = conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO rename_operation VALUES (1, 'B.md', 'C.md', 0)",
        [],
    )
    .unwrap();
    for (ordinal, (path, before, after)) in changes.iter().enumerate() {
        let started = ordinal < applied || (ordinal == applied && next_started);
        tx.execute(
            "INSERT INTO rename_steps VALUES (?1, ?2, ?3, ?4, 420, ?5)",
            params![
                i64::try_from(ordinal).unwrap(),
                path,
                before,
                after,
                started
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    for (path, _, after) in changes.iter().take(applied) {
        match after {
            Some(bytes) => fs::write(root.join(path), bytes).unwrap(),
            None => fs::remove_file(root.join(path)).unwrap(),
        }
    }
}

#[test]
fn reopening_recovers_every_interruption_boundary() {
    for applied in 0..=4 {
        for next_started in [false, true] {
            let (root, state, vault) = setup();
            drop(vault);
            interrupted(root.path(), &state, applied, next_started);
            let reopened = Vault::open(root.path(), state.path()).unwrap();
            assert_original(root.path());
            assert_eq!(reopened.links_to("B.md").unwrap().len(), 2);
            assert_journal_cleared(&state);
        }
    }
}

#[test]
fn reopening_recovers_any_uncommitted_subset_before_directory_sync() {
    // 同一事务在提交前合并目录同步；断电后可见的文件替换不一定构成执行顺序的前缀。
    let before: [(&str, Option<&[u8]>); 4] = [
        ("C.md", None),
        ("A.md", Some(b"[[B]]\n")),
        ("D.md", Some(b"[B](./B.md)\n")),
        ("B.md", Some(b"note\n")),
    ];
    for visible in 0_u8..16 {
        let (root, state, vault) = setup();
        drop(vault);
        interrupted(root.path(), &state, 4, false);
        for (ordinal, (path, bytes)) in before.iter().enumerate() {
            if visible & (1 << ordinal) != 0 {
                continue;
            }
            match bytes {
                Some(bytes) => fs::write(root.path().join(path), bytes).unwrap(),
                None => fs::remove_file(root.path().join(path)).unwrap(),
            }
        }
        let reopened = Vault::open(root.path(), state.path()).unwrap();
        assert_original(root.path());
        assert_eq!(reopened.links_to("B.md").unwrap().len(), 2);
        assert_journal_cleared(&state);
    }
}

#[test]
fn reopening_can_resume_an_interrupted_rollback() {
    let (root, state, vault) = setup();
    drop(vault);
    interrupted(root.path(), &state, 4, false);
    fs::write(root.path().join("B.md"), b"note\n").unwrap();
    fs::write(root.path().join("D.md"), b"[B](./B.md)\n").unwrap();
    Vault::open(root.path(), state.path()).unwrap();
    assert_original(root.path());
    assert_journal_cleared(&state);
}

#[test]
fn recovery_preserves_external_changes_and_retries_after_the_conflict_is_resolved() {
    let (root, state, vault) = setup();
    drop(vault);
    interrupted(root.path(), &state, 4, false);
    fs::write(root.path().join("C.md"), b"external work").unwrap();
    let err = Vault::open(root.path(), state.path())
        .err()
        .expect("外部内容不能被删除");
    assert!(matches!(err, Error::RenameRecovery { .. }));
    assert!(err.to_string().contains("C.md"));
    assert_eq!(
        fs::read(root.path().join("C.md")).unwrap(),
        b"external work"
    );
    fs::rename(root.path().join("C.md"), root.path().join("external.md")).unwrap();
    Vault::open(root.path(), state.path()).unwrap();
    assert_eq!(
        fs::read(root.path().join("external.md")).unwrap(),
        b"external work"
    );
    assert_eq!(fs::read(root.path().join("B.md")).unwrap(), b"note\n");
    assert_eq!(fs::read(root.path().join("A.md")).unwrap(), b"[[B]]\n");
    assert_journal_cleared(&state);
}

#[test]
fn recovery_never_touches_an_unstarted_destination() {
    let (root, state, vault) = setup();
    drop(vault);
    interrupted(root.path(), &state, 0, false);
    fs::write(root.path().join("C.md"), b"someone else's file").unwrap();
    Vault::open(root.path(), state.path()).unwrap();
    assert_eq!(
        fs::read(root.path().join("C.md")).unwrap(),
        b"someone else's file"
    );
    assert_journal_cleared(&state);
}

#[test]
fn recovery_preserves_directories_that_were_only_planned() {
    for legacy in [false, true] {
        let (root, state, vault) = setup();
        fs::create_dir_all(root.path().join("old/empty")).unwrap();
        recovery(&state)
            .execute_batch(
                "INSERT INTO rename_operation VALUES (1, 'old', 'new', 0);
             INSERT INTO rename_directories VALUES (0, 'new'), (1, 'new/empty');",
            )
            .unwrap();
        drop(vault);
        if legacy {
            recovery(&state)
                .execute_batch("DROP TABLE rename_created_directories;")
                .unwrap();
        }
        // 计划落盘后尚未创建目录便退出；同名空目录可能由其他进程创建。
        fs::create_dir_all(root.path().join("new/empty")).unwrap();

        Vault::open(root.path(), state.path()).unwrap();
        assert!(root.path().join("old/empty").is_dir());
        assert!(root.path().join("new/empty").is_dir());
        assert_journal_cleared(&state);
    }
}

#[test]
fn reopening_cleans_only_confirmed_directories_at_each_creation_boundary() {
    for confirmed in 0..=2 {
        let (root, state, vault) = setup();
        fs::create_dir_all(root.path().join("old/empty")).unwrap();
        recovery(&state)
            .execute_batch(
                "INSERT INTO rename_operation VALUES (1, 'old', 'new', 0);
             INSERT INTO rename_directories VALUES (0, 'new'), (1, 'new/empty');",
            )
            .unwrap();
        fs::create_dir_all(root.path().join("new/empty")).unwrap();
        for directory in ["new", "new/empty"].iter().take(confirmed) {
            recovery(&state)
                .execute(
                    "INSERT INTO rename_created_directories VALUES (?1)",
                    [directory],
                )
                .unwrap();
        }
        drop(vault);

        Vault::open(root.path(), state.path()).unwrap();
        assert!(root.path().join("old/empty").is_dir());
        // 创建与归属记录之间的中断允许留下空目录，但不得删除归属不明的目录。
        assert_eq!(root.path().join("new/empty").is_dir(), confirmed < 2);
        assert_eq!(root.path().join("new").is_dir(), confirmed < 2);
        assert_journal_cleared(&state);
    }
}

#[test]
fn failure_to_record_directory_ownership_removes_the_new_empty_directory() {
    for directory in ["new", "new/empty"] {
        let (root, state, vault) = setup();
        fs::create_dir_all(root.path().join("old/empty")).unwrap();
        fs::write(root.path().join("old/note.md"), b"preserve source").unwrap();
        recovery(&state).execute_batch(&format!(
            "CREATE TRIGGER reject_directory BEFORE INSERT ON rename_created_directories
             WHEN NEW.path = '{directory}' BEGIN SELECT RAISE(ABORT, 'directory record failure'); END;",
        )).unwrap();

        assert!(vault.rename("old", "new").is_err());
        assert!(root.path().join("old/empty").is_dir());
        assert_eq!(
            fs::read(root.path().join("old/note.md")).unwrap(),
            b"preserve source"
        );
        assert!(!root.path().join("new").exists());
        assert_journal_cleared(&state);
    }
}

#[test]
fn unresolved_recovery_blocks_disk_writes_but_keeps_the_new_draft() {
    let (root, state, vault) = setup();
    interrupted(root.path(), &state, 1, false);
    fs::write(root.path().join("C.md"), b"external").unwrap();
    let result = vault.write("A.md", b"latest editing", Some(b"[[B]]\n"));
    assert!(matches!(result, Err(Error::RenameRecovery { .. })));
    assert_eq!(fs::read(root.path().join("A.md")).unwrap(), b"[[B]]\n");
    assert_eq!(
        vault.snapshot("A.md").unwrap().draft.unwrap().bytes,
        b"latest editing"
    );
}

#[test]
fn pending_drafts_prevent_renaming_their_link_targets() {
    let (root, _state, vault) = setup();
    vault
        .write("A.md", b"unsaved [[B]]", Some(b"outdated"))
        .unwrap();
    assert!(vault
        .rename("B.md", "C.md")
        .unwrap_err()
        .to_string()
        .contains("草稿"));
    assert_original(root.path());
}

#[cfg(unix)]
#[test]
fn source_permissions_survive_both_commit_and_rollback() {
    use std::os::unix::fs::PermissionsExt;
    let (root, state, vault) = setup();
    // 同时覆盖移动源、只读入链及私有入链；恢复必须使用各自的权限而非父目录权限。
    for (path, mode) in [("B.md", 0o4640), ("A.md", 0o440), ("D.md", 0o2600)] {
        fs::set_permissions(root.path().join(path), fs::Permissions::from_mode(mode)).unwrap();
    }
    let conn = recovery(&state);
    conn.execute_batch("CREATE TRIGGER reject_commit BEFORE UPDATE OF committed ON rename_operation BEGIN SELECT RAISE(ABORT, 'commit failure'); END;").unwrap();
    assert!(vault.rename("B.md", "C.md").is_err());
    assert_original(root.path());
    for (path, mode) in [("B.md", 0o4640), ("A.md", 0o440), ("D.md", 0o2600)] {
        assert_eq!(
            fs::metadata(root.path().join(path))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            mode
        );
    }
    conn.execute_batch("DROP TRIGGER reject_commit;").unwrap();
    vault.rename("B.md", "C.md").unwrap();
    assert_committed(root.path());
    for (path, mode) in [("C.md", 0o4640), ("A.md", 0o440), ("D.md", 0o2600)] {
        assert_eq!(
            fs::metadata(root.path().join(path))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            mode
        );
    }
}

#[cfg(unix)]
#[test]
fn rename_cannot_follow_a_destination_directory_symlink_outside_the_vault() {
    let (root, _state, vault) = setup();
    let outside = TempDir::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
    assert!(matches!(
        vault.rename("B.md", "escape/C.md"),
        Err(Error::PathEscape)
    ));
    assert_eq!(fs::read(root.path().join("A.md")).unwrap(), b"[[B]]\n");
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[test]
fn rollback_removes_empty_directories_created_for_the_destination() {
    let (root, state, vault) = setup();
    recovery(&state).execute_batch("CREATE TRIGGER reject_commit BEFORE UPDATE OF committed ON rename_operation BEGIN SELECT RAISE(ABORT, 'commit failure'); END;").unwrap();
    assert!(vault.rename("B.md", "new/nested/C.md").is_err());
    assert_original(root.path());
    assert!(!root.path().join("new").exists());
    assert_journal_cleared(&state);
}

#[test]
fn another_kernel_waits_for_the_active_operation_before_attempting_recovery() {
    let (root, state, _vault) = setup();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(state.path().join("operations.lock"))
        .unwrap();
    lock.lock().unwrap();
    let root_path = root.path().to_path_buf();
    let state_path = state.path().to_path_buf();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        let opened = Vault::open(root_path, state_path);
        done_tx.send(opened.is_ok()).unwrap();
    });
    started_rx.recv().unwrap();
    assert!(done_rx
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());
    drop(lock);
    assert!(done_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap());
    thread.join().unwrap();
}
