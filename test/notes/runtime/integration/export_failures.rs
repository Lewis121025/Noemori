//! 非正常文件状态和恢复记录必须保留原数据，并能定位拒绝发生的阶段。
use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn export_keeps_commit_evidence_when_receipt_publication_fails_and_runtime_shuts_down() {
    let (data, root, output, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    action(
        &runtime,
        json!({"action":"write","path":"result.pdf","resource":false}),
        b"new complete result".to_vec(),
    )
    .await
    .unwrap();
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    let target = output.path().join("result.pdf");
    fs::write(&target, b"previous result").unwrap();
    action(&runtime, json!({"action":"target","path":target}), vec![])
        .await
        .unwrap();
    let obstruction = data.path().join("export-jobs/pending-test-job.json");
    fs::create_dir(&obstruction).unwrap();
    let saved = action(
        &runtime,
        json!({"action":"publish","single":"result.pdf"}),
        vec![],
    )
    .await
    .unwrap();
    assert_eq!(
        saved["path"],
        target.canonicalize().unwrap().to_str().unwrap()
    );
    assert!(saved["warning"].as_str().unwrap().contains("结果已生成"));
    // 同时覆盖已有目标、交付凭据写失败、finally 未执行就关闭的组合，不能丢掉提交事实。
    runtime.shutdown().await.unwrap();
    fs::remove_dir(obstruction).unwrap();
    let reopened = Runtime::new(data.path().into(), |_| {});
    let recovered = reopened
        .write(false, State::export_recover)
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recovered,
        json!([{"id":"test-job","path":target.canonicalize().unwrap(),"status":"saved"}])
    );
    assert_eq!(fs::read(target).unwrap(), b"new complete result");
    action(&reopened, json!({"action":"acknowledge"}), vec![])
        .await
        .unwrap();
    reopened.shutdown().await.unwrap();
}

fn receipt(root: &Path) -> recovery::Receipt {
    let temporary = root.join(".noemori-export-owned");
    fs::write(&temporary, b"complete").unwrap();
    let digest = export_file_hash(&temporary, &mut |_| Ok(())).unwrap();
    recovery::Receipt {
        version: 1,
        id: "pending-job".into(),
        target: root.join("result.zip"),
        temporary_identity: recovery::PathIdentity::of(&fs::metadata(&temporary).unwrap()),
        temporary,
        hash: Some(digest.0),
        bytes: Some(digest.1),
    }
}

#[test]
fn export_recovery_rejects_corrupt_receipts_without_deleting_targets_or_temporary_files() {
    let directory = tempfile::tempdir().unwrap();
    let outputs = tempfile::tempdir().unwrap();
    let original = receipt(outputs.path());
    fs::write(&original.target, b"previous").unwrap();
    let value = serde_json::to_value(&original).unwrap();
    for (key, changed) in [
        ("version", json!(2)),
        ("id", json!("../escape")),
        ("target", json!("relative.zip")),
        ("temporary", json!("relative.part")),
        (
            "temporary",
            json!(directory.path().join(".noemori-export-owned")),
        ),
        ("temporary", json!(outputs.path().join("unowned-file"))),
        ("hash", Value::Null),
        ("bytes", Value::Null),
        ("hash", json!("a".repeat(63))),
        ("hash", json!("g".repeat(64))),
        ("unexpected", json!(true)),
    ] {
        let mut mutated = value.clone();
        mutated[key] = changed;
        let path = recovery::pending(directory.path(), &original.id).unwrap();
        fs::write(&path, serde_json::to_vec(&mutated).unwrap()).unwrap();
        assert!(recovery::recover(directory.path()).is_err(), "{key}");
        assert_eq!(fs::read(&original.target).unwrap(), b"previous");
        assert_eq!(fs::read(&original.temporary).unwrap(), b"complete");
        fs::remove_file(path).unwrap();
    }
    fs::write(
        directory.path().join("pending-wrong.json"),
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();
    assert!(recovery::recover(directory.path()).is_err());
    assert!(original.temporary.exists());
}

#[test]
fn export_receipts_are_idempotent_but_never_replace_an_unconfirmed_task_identity() {
    let directory = tempfile::tempdir().unwrap();
    let outputs = tempfile::tempdir().unwrap();
    let mut original = receipt(outputs.path());
    recovery::remember(directory.path(), &original).unwrap();
    recovery::remember(directory.path(), &original).unwrap();
    let bytes = fs::read(recovery::pending(directory.path(), &original.id).unwrap()).unwrap();
    original.target = outputs.path().join("different.zip");
    assert!(recovery::remember(directory.path(), &original).is_err());
    assert_eq!(
        fs::read(recovery::pending(directory.path(), &original.id).unwrap()).unwrap(),
        bytes
    );
    for id in ["", "bad/id", &"x".repeat(101)] {
        assert!(recovery::pending(directory.path(), id).is_err());
        assert!(recovery::acknowledge(directory.path(), id).is_err());
    }
    let blocked = recovery::pending(directory.path(), "blocked").unwrap();
    fs::create_dir(&blocked).unwrap();
    assert!(recovery::acknowledge(directory.path(), "blocked").is_err());
    assert!(blocked.is_dir());
    recovery::acknowledge(directory.path(), "missing").unwrap();
}

#[test]
fn export_recovery_distinguishes_precommit_intent_and_protects_replaced_temp_paths() {
    for replacement in ["same", "symlink", "directory", "removed"] {
        let directory = tempfile::tempdir().unwrap();
        let outputs = tempfile::tempdir().unwrap();
        let mut original = receipt(outputs.path());
        original.hash = None;
        original.bytes = None;
        recovery::remember(directory.path(), &original).unwrap();
        if replacement != "same" {
            fs::remove_file(&original.temporary).unwrap();
        }
        match replacement {
            "symlink" => std::os::unix::fs::symlink(&original.target, &original.temporary).unwrap(),
            "directory" => fs::create_dir(&original.temporary).unwrap(),
            _ => {}
        }
        fs::write(&original.target, b"previous").unwrap();
        let recovered = serde_json::to_value(recovery::recover(directory.path()).unwrap()).unwrap();
        assert_eq!(recovered[0]["status"], "unconfirmed");
        assert_eq!(fs::read(&original.target).unwrap(), b"previous");
        if replacement == "symlink" || replacement == "directory" {
            assert!(fs::symlink_metadata(&original.temporary).is_ok());
        } else {
            assert!(!original.temporary.exists());
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn export_denies_invalid_targets_and_missing_resources_before_any_publication() {
    let (_data, root, output, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    let link = output.path().join("link.zip");
    std::os::unix::fs::symlink(root.path().join("a.md"), &link).unwrap();
    for target in [
        PathBuf::from("relative.zip"),
        PathBuf::from("/"),
        output.path().into(),
        link,
    ] {
        assert!(
            action(&runtime, json!({"action":"target","path":target}), vec![])
                .await
                .is_err()
        );
    }
    assert!(action(
        &runtime,
        json!({"action":"copy","source":"missing","path":"unused"}),
        vec![]
    )
    .await
    .is_err());
    assert!(action(&runtime, json!({"action":"acknowledge"}), vec![])
        .await
        .is_err());
    runtime
        .write(false, |state| -> Result<()> {
            assert!(state.export_recover().is_err());
            let job = state.export.as_mut().unwrap();
            assert!(job.check_budget(EXPORT_FILE_LIMIT, 0).is_err());
            assert!(job.check_budget(0, EXPORT_BYTE_LIMIT).is_err());
            assert!(job
                .check_budget(
                    EXPORT_FILE_LIMIT - job.source.file_count(),
                    EXPORT_BYTE_LIMIT - job.source.bytes()
                )
                .is_ok());
            Ok(())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    assert!(
        action(&runtime, json!({"action":"publish","single":null}), vec![])
            .await
            .is_err()
    );
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}
