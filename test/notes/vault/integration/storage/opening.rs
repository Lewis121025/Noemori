use nous_vault::{Error, OpenPhase, Vault};
use std::fs;
use tempfile::TempDir;

#[test]
fn cancellation_does_not_wait_for_another_operation_lock() {
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        thread,
        time::Duration,
    };
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(index.path().join("operations.lock"))
        .unwrap();
    lock.lock().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let cancellation = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&cancellation);
    let root_path = root.path().to_path_buf();
    let index_path = index.path().to_path_buf();
    let worker = thread::spawn(move || {
        let mut reported = false;
        let result = Vault::open_with_progress(root_path, index_path, &mut |_| {
            if !reported {
                reported = true;
                started_tx.send(()).unwrap();
            }
            Ok(!signal.load(Ordering::Relaxed))
        });
        done_tx
            .send(matches!(result, Err(Error::OpenCancelled)))
            .unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    thread::sleep(Duration::from_millis(30));
    cancellation.store(true, Ordering::Relaxed);
    let cancelled_before_unlock = done_rx.recv_timeout(Duration::from_millis(300));
    drop(lock);
    worker.join().unwrap();
    assert_eq!(cancelled_before_unlock.ok(), Some(true));
}

#[test]
fn opening_can_stop_at_each_preparation_phase_and_retry() {
    for stop in [
        OpenPhase::Recovering,
        OpenPhase::Scanning,
        OpenPhase::Checking,
        OpenPhase::Reading,
        OpenPhase::Indexing,
        OpenPhase::Ranking,
    ] {
        let root = TempDir::new().unwrap();
        let index = TempDir::new().unwrap();
        fs::write(root.path().join("笔记.md"), "# 保留\n\n原始内容").unwrap();
        let result = Vault::open_with_progress(root.path(), index.path(), &mut |progress| {
            Ok(progress.phase != stop)
        });
        assert!(matches!(result, Err(Error::OpenCancelled)), "{stop:?}");
        let vault = Vault::open(root.path(), index.path()).unwrap();
        assert_eq!(
            vault.read("笔记.md").unwrap(),
            "# 保留\n\n原始内容".as_bytes()
        );
    }
}

#[test]
fn corrupt_derived_index_rebuilds_without_losing_drafts() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("笔记.md"), "磁盘版本").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    vault
        .write("笔记.md", "保留草稿".as_bytes(), Some(b"old"))
        .unwrap();
    drop(vault);
    fs::write(index.path().join("index.sqlite"), b"broken database").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let snapshot = vault.snapshot("笔记.md").unwrap();
    assert_eq!(snapshot.disk.unwrap(), "磁盘版本".as_bytes());
    assert_eq!(snapshot.draft.unwrap().bytes, "保留草稿".as_bytes());
}

#[test]
fn corrupt_ranking_metadata_rebuilds_from_notes() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("笔记.md"), "# 可检索\n\nneedle").unwrap();
    drop(Vault::open(root.path(), index.path()).unwrap());
    fs::write(
        index.path().join("search-v1/meta.json"),
        "{invalid metadata",
    )
    .unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let hits = vault
        .search(&nous_vault::SearchQuery {
            expr: nous_vault::SearchExpr::Term("needle".into()),
            limit: 10,
        })
        .unwrap();
    assert_eq!(hits.len(), 1);
}

#[test]
fn missing_ranking_segment_rebuilds_from_notes() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("笔记.md"), "needle 正文").unwrap();
    drop(Vault::open(root.path(), index.path()).unwrap());
    let segment = fs::read_dir(index.path().join("search-v1"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "term")
        })
        .unwrap();
    fs::remove_file(segment).unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(
        vault
            .search(&nous_vault::SearchQuery {
                expr: nous_vault::SearchExpr::Term("needle".into()),
                limit: 10
            })
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn verification_includes_files_changed_during_preparation() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("笔记.md"), "before").unwrap();
    let mut changed = false;
    let vault = Vault::open_with_progress(root.path(), index.path(), &mut |progress| {
        if progress.phase == OpenPhase::Ranking && !changed {
            changed = true;
            fs::write(root.path().join("笔记.md"), "after 新内容").unwrap();
            fs::write(root.path().join("新增.md"), "after 新增").unwrap();
        }
        Ok(true)
    })
    .unwrap();
    vault.verify_opening(&mut |_| Ok(true)).unwrap();
    let hits = vault
        .search(&nous_vault::SearchQuery {
            expr: nous_vault::SearchExpr::Term("after".into()),
            limit: 10,
        })
        .unwrap();
    assert_eq!(hits.len(), 2);
}

#[cfg(unix)]
#[test]
fn unreadable_note_reports_its_path_and_can_be_retried() {
    use std::os::unix::fs::PermissionsExt;
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    let path = root.path().join("不可读.md");
    fs::write(&path, "保留").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
    let result = Vault::open(root.path(), index.path());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let Err(error) = result else {
        panic!("不可读文件不应被跳过");
    };
    assert!(error.to_string().contains("不可读.md"), "{error}");
    assert!(Vault::open(root.path(), index.path()).is_ok());
}
