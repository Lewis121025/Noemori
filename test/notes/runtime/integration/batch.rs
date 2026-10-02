//! 只替换系统废纸篓边界，真实 Vault 和会话磁盘验证预检、部分提交及停止契约。
use super::*;
use crate::Runtime;
use std::fs;

struct Fixture {
    data: tempfile::TempDir,
    root: tempfile::TempDir,
    trash: tempfile::TempDir,
    runtime: Runtime,
}

impl Fixture {
    async fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let trash = tempfile::tempdir().unwrap();
        for name in ["a.md", "b.md", "c.md"] {
            fs::write(root.path().join(name), name).unwrap();
        }
        let runtime = Runtime::new(data.path().into(), |_| {});
        let path = root.path().to_string_lossy().into_owned();
        runtime.write(false, move |state| {
            state.open(&path, false, &OperationControl::default()).unwrap();
            state.sessions.patch_reader(&json!({
                "documents": {"panes": [{"currentPath": "a.md", "history": {"back": [{"path": "b.md"}], "forward": []}}], "active": 0, "split": false},
                "recentFiles": ["a.md", "b.md", "c.md"]
            })).unwrap();
        }).wait().await.unwrap();
        Self {
            data,
            root,
            trash,
            runtime,
        }
    }

    fn request(&self, paths: &[&str]) -> Value {
        json!({"root": self.root.path().to_str().unwrap(), "action": "trash", "paths": paths})
    }

    fn reader(&self) -> Value {
        crate::session::SessionStore::new(self.data.path()).load()["reader"].clone()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn trash_failure_retains_committed_prefix_index_warning_and_retry_remainder() {
    let fixture = Fixture::new().await;
    let request = fixture.request(&["a.md", "b.md", "c.md"]);
    let destination = fixture.trash.path().to_path_buf();
    let (result, attempted) = fixture.runtime.write(true, move |state| {
        let conn = rusqlite::Connection::open(state.vault().unwrap().index_dir().join("index.sqlite")).unwrap();
        let mut attempted = Vec::new();
        let result = state.entry_batch_with_trash(request, &OperationControl::default(), |absolute| {
            let name = absolute.file_name().unwrap();
            attempted.push(name.to_string_lossy().into_owned());
            if attempted.len() == 2 {
                return Err(noemori_vault::Error::Io(std::io::Error::other("废纸篓不可用")));
            }
            fs::rename(absolute, destination.join(name))?;
            // 文件已移走后才让派生索引失败，验证 warning 不会把已提交项放回 remaining。
            conn.execute_batch("CREATE TRIGGER fail_trash_index BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, '注入索引失败'); END;").unwrap();
            Ok(())
        });
        conn.execute_batch("DROP TRIGGER fail_trash_index").unwrap();
        state.vault().unwrap().refresh_index().unwrap();
        (result.unwrap(), attempted)
    }).wait().await.unwrap();
    assert_eq!(attempted, ["a.md", "b.md"]);
    assert_eq!(result["completed"], json!([{"from": "a.md", "to": null}]));
    assert_eq!(result["remaining"], json!(["b.md", "c.md"]));
    assert_eq!(result["issues"].as_array().unwrap().len(), 1);
    assert_eq!(result["issues"][0]["path"], "b.md");
    assert!(result["issues"][0]["message"]
        .as_str()
        .unwrap()
        .contains("废纸篓不可用"));
    assert!(result["warning"].as_str().unwrap().contains("注入索引失败"));
    assert!(!fixture.root.path().join("a.md").exists());
    assert_eq!(
        fs::read(fixture.trash.path().join("a.md")).unwrap(),
        b"a.md"
    );
    assert!(fixture.root.path().join("b.md").exists());
    assert!(fixture.root.path().join("c.md").exists());
    let reader = fixture.reader();
    assert_eq!(reader["documents"]["panes"][0]["currentPath"], Value::Null);
    assert_eq!(
        reader["documents"]["panes"][0]["history"]["back"][0]["path"],
        "b.md"
    );
    assert_eq!(reader["recentFiles"], json!(["b.md", "c.md"]));

    let mut retry = fixture.request(&["b.md", "c.md"]);
    retry["paths"] = result["remaining"].clone();
    let destination = fixture.trash.path().to_path_buf();
    let retried = fixture
        .runtime
        .write(true, move |state| {
            state.entry_batch_with_trash(retry, &OperationControl::default(), |absolute| {
                fs::rename(absolute, destination.join(absolute.file_name().unwrap()))?;
                Ok(())
            })
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        retried["completed"],
        json!([{"from": "b.md", "to": null}, {"from": "c.md", "to": null}])
    );
    assert_eq!(retried["remaining"], json!([]));
    assert_eq!(retried["issues"], json!([]));
    assert_eq!(retried["warning"], Value::Null);
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn trash_cancellation_during_a_transaction_keeps_that_item_committed() {
    let fixture = Fixture::new().await;
    let request = fixture.request(&["a.md", "b.md"]);
    let destination = fixture.trash.path().to_path_buf();
    let result = fixture
        .runtime
        .write(true, move |state| {
            let control = OperationControl::default();
            let mut attempted = 0;
            let result = state
                .entry_batch_with_trash(request, &control, |absolute| {
                    attempted += 1;
                    assert!(control.cancel());
                    fs::rename(absolute, destination.join(absolute.file_name().unwrap()))?;
                    Ok(())
                })
                .unwrap();
            assert_eq!(attempted, 1);
            assert_eq!(control.progress().completed, 1);
            result
        })
        .wait()
        .await
        .unwrap();
    assert_eq!(result["completed"], json!([{"from": "a.md", "to": null}]));
    assert_eq!(result["remaining"], json!(["b.md"]));
    assert_eq!(result["issues"], json!([]));
    assert_eq!(result["warning"], Value::Null);
    assert_eq!(fixture.reader()["recentFiles"], json!(["b.md", "c.md"]));
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn trash_preflight_checks_all_drafts_before_calling_the_system() {
    let fixture = Fixture::new().await;
    let request = fixture.request(&["a.md", "b.md"]);
    let result = fixture
        .runtime
        .write(true, move |state| {
            state
                .vault()
                .unwrap()
                .preserve_editor_draft("b.md", b"unsaved", Some(b"b.md"), "editor")
                .unwrap();
            state.entry_batch_with_trash(request, &OperationControl::default(), |_| {
                panic!("后续条目有未保存草稿时不得执行任何系统操作")
            })
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["completed"], json!([]));
    assert_eq!(result["remaining"], json!(["a.md", "b.md"]));
    assert!(result["issues"][0]["message"]
        .as_str()
        .unwrap()
        .contains("未保存草稿"));
    assert!(fixture.root.path().join("a.md").exists());
    assert!(fixture.root.path().join("b.md").exists());
    fixture.runtime.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn trash_session_warning_does_not_stop_remaining_file_transactions() {
    let fixture = Fixture::new().await;
    let request = fixture.request(&["a.md", "b.md"]);
    let destination = fixture.trash.path().to_path_buf();
    let previous = fs::read(fixture.data.path().join("session.json")).unwrap();
    let permissions = fs::metadata(fixture.data.path()).unwrap().permissions();
    let mut read_only = permissions.clone();
    read_only.set_readonly(true);
    fs::set_permissions(fixture.data.path(), read_only).unwrap();
    let result = fixture
        .runtime
        .write(true, move |state| {
            state.entry_batch_with_trash(request, &OperationControl::default(), |absolute| {
                fs::rename(absolute, destination.join(absolute.file_name().unwrap()))?;
                Ok(())
            })
        })
        .wait()
        .await;
    fs::set_permissions(fixture.data.path(), permissions).unwrap();
    let result = result.unwrap().unwrap();
    assert_eq!(
        result["completed"],
        json!([{"from": "a.md", "to": null}, {"from": "b.md", "to": null}])
    );
    assert_eq!(result["remaining"], json!([]));
    assert_eq!(result["issues"], json!([]));
    let warning = result["warning"].as_str().unwrap();
    assert!(warning.contains("a.md：文件操作已完成，会话更新失败"));
    assert!(warning.contains("b.md：文件操作已完成，会话更新失败"));
    assert_eq!(
        fs::read(fixture.data.path().join("session.json")).unwrap(),
        previous
    );
    for name in ["a.md", "b.md"] {
        assert!(!fixture.root.path().join(name).exists());
        assert_eq!(
            fs::read(fixture.trash.path().join(name)).unwrap(),
            name.as_bytes()
        );
    }
    fixture.runtime.shutdown().await.unwrap();
}
