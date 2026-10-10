use noemori_vault::Vault;
use std::fs;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;

#[test]
fn resource_watch_drop_releases_its_vault_across_repeated_lifecycles() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("note.md"), "# Note\n").unwrap();
    for _ in 0..20 {
        let vault = Arc::new(Vault::open(root.path(), index.path()).unwrap());
        let lifetime = Arc::downgrade(&vault);
        let watched = Arc::clone(&vault);
        let handle =
            noemori_vault::start_watch(root.path(), Duration::from_millis(20), move |_| {
                watched.refresh_index().unwrap();
            })
            .unwrap();
        drop(vault);
        assert!(lifetime.upgrade().is_some());
        drop(handle);
        assert!(lifetime.upgrade().is_none(), "监视器释放后不能继续持有旧库");
    }
}

#[test]
fn external_edit_refreshes_backlinks_after_debounce() {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    fs::write(root.path().join("A.md"), "hello\n").expect("A");
    fs::write(root.path().join("B.md"), "# B\n").expect("B");
    let vault = Arc::new(Vault::open(root.path(), index.path()).expect("打开"));
    assert!(vault.links_to("B.md").expect("入链").is_empty());

    let (tx, rx) = mpsc::channel();
    let watched = Arc::clone(&vault);
    let _handle =
        noemori_vault::start_watch(root.path(), Duration::from_millis(80), move |event| {
            assert!(event.is_ok());
            let _ = watched.refresh_index();
            let _ = tx.send(());
        })
        .expect("监视");

    fs::write(root.path().join("A.md"), "[[B]]\n").expect("外改");
    rx.recv_timeout(Duration::from_secs(3))
        .expect("等到监视回调");

    let incoming = vault.links_to("B.md").expect("刷新后入链");
    assert!(incoming.iter().any(|link| link.from_path == "A.md"));
}

#[test]
fn removing_an_empty_directory_refreshes_the_inventory() {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    fs::create_dir(root.path().join("source")).expect("空目录");
    let vault = Arc::new(Vault::open(root.path(), index.path()).expect("打开"));
    let (tx, rx) = mpsc::channel();
    let watched = Arc::clone(&vault);
    let _handle =
        noemori_vault::start_watch(root.path(), Duration::from_millis(80), move |event| {
            assert!(event.is_ok());
            watched.refresh_index().expect("更新目录");
            let _ = tx.send(watched.list_entries().expect("目录快照"));
        })
        .expect("监视");
    fs::remove_dir(root.path().join("source")).expect("外部删除");
    let entries = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("收到空目录删除通知");
    assert!(entries.is_empty(), "删除的空目录不能继续留在目录缓存");
}
