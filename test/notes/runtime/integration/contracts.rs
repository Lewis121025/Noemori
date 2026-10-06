//! 通过真实文件和阻塞闸门验证应用契约，不依赖 Node 或事件循环时序猜测。
use noemori_runtime::{OperationControl, Runtime};
use serde_json::json;
use std::{
    fs,
    sync::{mpsc, Arc},
    time::Duration,
};

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_generation_advances_on_close_and_reopen() {
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let mut previous = runtime.generation();
    for _ in 0..2 {
        let path = root.path().to_string_lossy().into_owned();
        runtime
            .write(false, move |state| {
                state.open(&path, false, &OperationControl::default())
            })
            .wait()
            .await
            .unwrap()
            .unwrap();
        assert!(runtime.generation() > previous);
        previous = runtime.generation();
        runtime
            .write(false, noemori_runtime::State::close)
            .wait()
            .await
            .unwrap()
            .unwrap();
        assert!(
            runtime.generation() > previous,
            "关库必须推进代次，不能回到旧代次"
        );
        previous = runtime.generation();
    }
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_keep_submission_order_and_shutdown_drains() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(dir.path().into(), |_| {});
    let (release, blocked) = mpsc::channel();
    let (entered, entrance) = tokio::sync::oneshot::channel();
    let first = runtime.write(false, move |state| {
        entered.send(()).unwrap();
        blocked.recv().unwrap();
        state
            .sessions
            .patch(&json!({"appearance": "dark"}))
            .unwrap();
    });
    entrance.await.unwrap();
    let second = runtime.write(false, |s| {
        s.sessions
            .patch(&json!({"window": {"x":1,"y":2,"width":800,"height":600,"maximized":false}}))
    });
    let third = runtime.write(false, |s| s.sessions.load());
    let read_cancellation = runtime.read_cancellation();
    assert!(!read_cancellation.is_cancelled());
    let stopping = runtime.shutdown();
    assert!(
        read_cancellation.is_cancelled(),
        "停机先取消只读扫描，仍等待已接受的写入完成"
    );
    assert!(runtime.write(false, |_| ()).wait().await.is_err());
    release.send(()).unwrap();
    first.wait().await.unwrap();
    second.wait().await.unwrap().unwrap();
    let session = third.wait().await.unwrap();
    assert_eq!(session["appearance"], "dark");
    assert_eq!(session["window"]["width"], 800);
    stopping.await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(dir.path().join("session.json")).unwrap()
        )
        .unwrap()["appearance"],
        "dark"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_open_preserves_previous_vault_and_session() {
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("a.md"), "原文").unwrap();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let path = root.path().to_string_lossy().into_owned();
    runtime
        .write(false, move |s| {
            s.open(&path, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let before = fs::read(data.path().join("session.json")).unwrap();
    let cancelled = OperationControl::default();
    assert!(cancelled.cancel());
    let path = root.path().to_string_lossy().into_owned();
    assert!(runtime
        .write(false, move |s| s.open(&path, false, &cancelled))
        .wait()
        .await
        .unwrap()
        .unwrap()
        .is_null());
    assert_eq!(
        runtime
            .read(|v| v.read("a.md"))
            .wait()
            .await
            .unwrap()
            .unwrap(),
        "原文".as_bytes()
    );
    assert_eq!(fs::read(data.path().join("session.json")).unwrap(), before);
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn blocked_read_does_not_block_save_or_cancellation() {
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("a.md"), "old").unwrap();
    let runtime = Arc::new(Runtime::new(data.path().into(), |_| {}));
    let path = root.path().to_string_lossy().into_owned();
    runtime
        .write(false, move |s| {
            s.open(&path, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let (release, blocked) = mpsc::channel();
    let (entered, entrance) = tokio::sync::oneshot::channel();
    let read = runtime.read(move |_| {
        entered.send(()).unwrap();
        blocked.recv().unwrap();
    });
    entrance.await.unwrap();
    let token = runtime.search("query".into(), false).unwrap();
    runtime.cancel_search("query");
    assert!(token.is_cancelled());
    let save = runtime.write(true, |s| {
        s.vault().unwrap().write("a.md", b"new", Some(b"old"))
    });
    tokio::time::timeout(Duration::from_secs(5), save.wait())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    release.send(()).unwrap();
    read.wait().await.unwrap();
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"new");
    runtime.shutdown().await.unwrap();
}

#[test]
fn legacy_session_and_path_remapping_preserve_reading_positions() {
    let data = tempfile::tempdir().unwrap();
    fs::write(data.path().join("session.json"), json!({"vaultRoot":"/v","currentPath":"a/x.md","sourceViews":["a/x.md"],"history":{"back":[{"path":"a/x.md","anchor":"标题","position":{"source":{"offset":3,"before":"中","after":"文"},"inset":2}}]},"leftWidth":0,"space":"connections"}).to_string()).unwrap();
    let store = noemori_runtime::session::SessionStore::new(data.path());
    store.remap("a", Some("b")).unwrap();
    let session = store.load();
    assert_eq!(
        session["reader"]["documents"]["panes"][0]["currentPath"],
        "b/x.md"
    );
    assert_eq!(
        session["reader"]["documents"]["panes"][0]["history"]["back"][0]["position"]["source"]
            ["offset"],
        3
    );
    assert_eq!(session["reader"]["viewModes"]["b/x.md"], "source");
    assert_eq!(session["reader"]["leftWidth"].as_f64(), Some(192.0));
    assert_eq!(session["reader"]["space"], "connections");
}

#[tokio::test(flavor = "multi_thread")]
async fn batch_preflight_and_session_failure_keep_commit_truth() {
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("target")).unwrap();
    for name in ["a.md", "b.md", "target/b.md"] {
        fs::write(root.path().join(name), name).unwrap();
    }
    let runtime = Runtime::new(data.path().into(), |_| {});
    let path = root.path().to_string_lossy().into_owned();
    let copy = path.clone();
    runtime
        .write(false, move |s| {
            s.open(&copy, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let request =
        json!({"root": path, "paths": ["a.md", "b.md"], "action": "move", "destination": "target"});
    let duplicate = request.clone();
    let conflict = runtime
        .write(true, move |s| {
            s.entry_batch(duplicate, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert!(conflict["completed"].as_array().unwrap().is_empty());
    assert!(root.path().join("a.md").exists());
    fs::remove_file(root.path().join("target/b.md")).unwrap();
    let cancelled = OperationControl::default();
    assert!(cancelled.cancel());
    let copy = request.clone();
    let stopped = runtime
        .write(true, move |s| s.entry_batch(copy, &cancelled))
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stopped["remaining"], json!(["a.md", "b.md"]));
    runtime
        .write(false, |s| {
            s.sessions.patch_reader(&json!({"recentFiles": ["a.md"]}))
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    // 会话仍可读取，但父目录不可写；改名提交后必须返回警告而非失败。
    let permissions = fs::metadata(data.path()).unwrap().permissions();
    let mut read_only = permissions.clone();
    read_only.set_readonly(true);
    fs::set_permissions(data.path(), read_only).unwrap();
    let result = runtime
        .write(true, |s| s.rename("a.md", "renamed.md"))
        .wait()
        .await;
    fs::set_permissions(data.path(), permissions).unwrap();
    let result = result.unwrap().unwrap();
    assert!(result.warning.unwrap().contains("会话更新失败"));
    assert_eq!(fs::read(root.path().join("renamed.md")).unwrap(), b"a.md");
    assert!(!root.path().join("a.md").exists());
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn read_bound_before_switch_cannot_publish_after_switch() {
    let data = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    fs::write(first.path().join("a.md"), "old").unwrap();
    fs::write(second.path().join("a.md"), "new").unwrap();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let root = first.path().to_string_lossy().into_owned();
    runtime
        .write(false, move |s| {
            s.open(&root, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let (release, blocked) = mpsc::channel();
    let (entered, entrance) = tokio::sync::oneshot::channel();
    let read = runtime.read(move |v| {
        entered.send(()).unwrap();
        blocked.recv().unwrap();
        v.read("a.md")
    });
    entrance.await.unwrap();
    let root = second.path().to_string_lossy().into_owned();
    runtime
        .write(false, move |s| {
            s.open(&root, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    release.send(()).unwrap();
    assert!(read.wait().await.is_err());
    assert_eq!(
        runtime
            .read(|v| v.read("a.md"))
            .wait()
            .await
            .unwrap()
            .unwrap(),
        b"new"
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn unexpected_write_panic_poisoning_never_replays_unknown_work() {
    let data = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let failed = runtime.write::<()>(false, |_| panic!("注入不可恢复故障"));
    assert!(failed
        .wait()
        .await
        .unwrap_err()
        .to_string()
        .contains("结果未知"));
    let executed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = Arc::clone(&executed);
    assert!(runtime
        .write(false, move |_| flag
            .store(true, std::sync::atomic::Ordering::Release))
        .wait()
        .await
        .is_err());
    assert!(!executed.load(std::sync::atomic::Ordering::Acquire));
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn saturated_read_slots_leave_the_write_lane_available() {
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let path = root.path().to_string_lossy().into_owned();
    runtime
        .write(false, move |s| {
            s.open(&path, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let (started, mut entered) = tokio::sync::mpsc::unbounded_channel();
    let mut releases = Vec::new();
    let mut reads = Vec::new();
    for index in 0..6 {
        let started = started.clone();
        let (release, blocked) = mpsc::channel();
        releases.push(release);
        reads.push(runtime.read(move |_| {
            started.send(index).unwrap();
            let _ = blocked.recv();
            index
        }));
    }
    for _ in 0..4 {
        tokio::time::timeout(Duration::from_secs(5), entered.recv())
            .await
            .unwrap()
            .unwrap();
    }
    let saved = runtime.write(false, |s| s.sessions.patch(&json!({"appearance":"dark"})));
    tokio::time::timeout(Duration::from_secs(5), saved.wait())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(entered.try_recv().is_err());
    for release in releases {
        release.send(()).unwrap();
    }
    for (index, read) in reads.into_iter().enumerate() {
        assert_eq!(read.wait().await.unwrap(), index);
    }
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn resource_switch_releases_the_old_pending_publication() {
    let data = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let root = first.path().to_string_lossy().into_owned();
    runtime
        .write(false, move |s| {
            s.open(&root, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    runtime
        .write(true, |s| s.write_file("a.md", b"pending", None))
        .wait()
        .await
        .unwrap()
        .unwrap();
    let previous = runtime.read(|v| Arc::downgrade(&v)).wait().await.unwrap();
    let root = second.path().to_string_lossy().into_owned();
    runtime
        .write(false, move |s| {
            s.open(&root, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let released = tokio::time::timeout(Duration::from_secs(1), async {
        while previous.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    runtime.shutdown().await.unwrap();
    assert!(released.is_ok(), "切库后旧排名请求不能继续持有整个 Vault");
}
#[test]
fn removed_reader_mode_is_ignored_without_changing_layout() {
    let data = tempfile::tempdir().unwrap();
    let store = noemori_runtime::session::SessionStore::new(data.path());
    store.patch_reader(&json!({"mode": "reading"})).unwrap();
    store
        .patch_reader(&json!({"filesCollapsed": true}))
        .unwrap();
    assert!(store.load()["reader"].get("mode").is_none());
    assert_eq!(store.load()["reader"]["filesCollapsed"], true);
    store.patch_reader(&json!({"mode": "editing"})).unwrap();
    assert!(store.load()["reader"].get("mode").is_none());
    store.patch_reader(&json!({"mode": "unknown"})).unwrap();
    assert!(store.load()["reader"].get("mode").is_none());
}
