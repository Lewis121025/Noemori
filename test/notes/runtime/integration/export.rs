//! 使用真实文件和真实任务队列验证输出事务；故障通过文件状态和控制句柄注入。
use super::*;
use crate::Runtime;
use std::io::Read;

#[path = "../performance/export.rs"]
mod stress;

#[path = "export_failures.rs"]
mod failures;

async fn fixture() -> (TempDir, TempDir, TempDir, Runtime) {
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    fs::write(root.path().join("a.md"), "# 原文\n").unwrap();
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
    (data, root, output, runtime)
}

async fn prepare(runtime: &Runtime, root: &Path, control: OperationControl) {
    let root = root.to_string_lossy().into_owned();
    runtime
        .write(true, move |s| {
            s.export_prepare(&root, "test-job".into(), None, true, control)
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
}

async fn action(runtime: &Runtime, value: Value, bytes: Vec<u8>) -> Result<Value> {
    runtime
        .write(false, move |s| s.export_action("test-job", value, &bytes))
        .wait()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn output_size_is_not_restricted_by_the_remote_image_limit() {
    let (_data, root, out, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    let bytes = vec![42; 64 * 1024 * 1024 + 1];
    assert!(action(
        &runtime,
        json!({"action":"write","path":"remote.bin","resource":true}),
        bytes.clone()
    )
    .await
    .is_err());
    action(
        &runtime,
        json!({"action":"write","path":"remote.bin","resource":true}),
        bytes[..64 * 1024 * 1024].to_vec(),
    )
    .await
    .unwrap();
    action(
        &runtime,
        json!({"action":"write","path":"large.docx","resource":false}),
        bytes,
    )
    .await
    .unwrap();
    action(
        &runtime,
        json!({"action":"retain","paths":["large.docx"]}),
        vec![],
    )
    .await
    .unwrap();
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    let target = out.path().join("large.docx");
    action(&runtime, json!({"action":"target","path":target}), vec![])
        .await
        .unwrap();
    action(
        &runtime,
        json!({"action":"publish","single":"large.docx"}),
        vec![],
    )
    .await
    .unwrap();
    assert_eq!(fs::metadata(target).unwrap().len(), 64 * 1024 * 1024 + 1);
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    action(&runtime, json!({"action":"acknowledge"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn publishes_verified_zip_and_cleans_only_owned_staging() {
    let (data, root, out, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    action(
        &runtime,
        json!({"action":"copy","source":"a.md","path":"vault/a.md"}),
        vec![],
    )
    .await
    .unwrap();
    action(
        &runtime,
        json!({"action":"directory","path":"vault/empty"}),
        vec![],
    )
    .await
    .unwrap();
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    let target = out.path().join("result.zip");
    assert!(action(&runtime, json!({"action":"outcome"}), vec![])
        .await
        .unwrap()
        .is_null());
    action(&runtime, json!({"action":"target","path":target}), vec![])
        .await
        .unwrap();
    let result = action(&runtime, json!({"action":"publish","single":null}), vec![])
        .await
        .unwrap();
    assert_eq!(
        result["path"],
        target.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(
        action(&runtime, json!({"action":"outcome"}), vec![])
            .await
            .unwrap(),
        result
    );
    let mut archive = zip::ZipArchive::new(fs::File::open(&target).unwrap()).unwrap();
    let mut text = String::new();
    archive
        .by_name("vault/a.md")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "# 原文\n");
    assert!(archive.by_name("vault/empty/").unwrap().is_dir());
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    action(&runtime, json!({"action":"acknowledge"}), vec![])
        .await
        .unwrap();
    assert_eq!(
        fs::read(root.path().join("a.md")).unwrap(),
        "# 原文\n".as_bytes()
    );
    assert_eq!(
        fs::read_dir(data.path().join("export-jobs"))
            .unwrap()
            .count(),
        1
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_and_target_races_never_replace_existing_output() {
    for scenario in ["cancel", "modified", "replaced"] {
        let (_data, root, out, runtime) = fixture().await;
        let control = OperationControl::default();
        prepare(&runtime, root.path(), control.clone()).await;
        action(
            &runtime,
            json!({"action":"write","path":"a.pdf","resource":false}),
            b"new output".to_vec(),
        )
        .await
        .unwrap();
        action(&runtime, json!({"action":"seal"}), vec![])
            .await
            .unwrap();
        let target = out.path().join("a.pdf");
        fs::write(&target, b"old").unwrap();
        action(&runtime, json!({"action":"target","path":target}), vec![])
            .await
            .unwrap();
        match scenario {
            "cancel" => {
                assert!(control.cancel());
            }
            "modified" => {
                fs::write(&target, b"external").unwrap();
            }
            _ => {
                let replacement = out.path().join("replacement");
                fs::write(&replacement, b"old").unwrap();
                fs::rename(&replacement, &target).unwrap();
            }
        }
        assert!(action(
            &runtime,
            json!({"action":"publish","single":"a.pdf"}),
            vec![]
        )
        .await
        .is_err());
        assert_eq!(
            fs::read(&target).unwrap(),
            if scenario == "modified" {
                b"external".as_slice()
            } else {
                b"old".as_slice()
            }
        );
        action(&runtime, json!({"action":"discard"}), vec![])
            .await
            .unwrap();
        runtime.shutdown().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn denies_invalid_paths_unsealed_publish_and_tampered_outputs() {
    let (_data, root, out, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    for path in ["../escape", "/absolute", ""] {
        assert!(action(
            &runtime,
            json!({"action":"write","path":path,"resource":false}),
            vec![1]
        )
        .await
        .is_err());
    }
    assert!(action(
        &runtime,
        json!({"action":"target","path":root.path().join("inside.pdf")}),
        vec![]
    )
    .await
    .is_err());
    action(
        &runtime,
        json!({"action":"write","path":"one","resource":false}),
        vec![1],
    )
    .await
    .unwrap();
    action(
        &runtime,
        json!({"action":"target","path":out.path().join("out")}),
        vec![],
    )
    .await
    .unwrap();
    assert!(
        action(&runtime, json!({"action":"publish","single":"one"}), vec![])
            .await
            .is_err()
    );
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    let info = action(&runtime, json!({"action":"info"}), vec![])
        .await
        .unwrap();
    fs::write(
        Path::new(info["outputDirectory"].as_str().unwrap()).join("one"),
        b"changed",
    )
    .unwrap();
    assert!(
        action(&runtime, json!({"action":"publish","single":"one"}), vec![])
            .await
            .is_err()
    );
    assert!(!out.path().join("out").exists());
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_late_tasks_after_reopening_the_same_vault() {
    let (_data, root, _out, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    let path = root.path().to_string_lossy().into_owned();
    runtime
        .write(false, move |state| {
            state.close()?;
            state.open(&path, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert!(action(
        &runtime,
        json!({"action":"write","path":"late","resource":false}),
        vec![1]
    )
    .await
    .is_err());
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn archive_contains_explicit_empty_directories_without_discarded_intermediates() {
    let (_data, root, out, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    action(
        &runtime,
        json!({"action":"write","path":"resources/image.png","resource":false}),
        vec![1],
    )
    .await
    .unwrap();
    action(
        &runtime,
        json!({"action":"write","path":"documents/a.pdf","resource":false}),
        vec![2],
    )
    .await
    .unwrap();
    action(
        &runtime,
        json!({"action":"directory","path":"empty"}),
        vec![],
    )
    .await
    .unwrap();
    action(
        &runtime,
        json!({"action":"retain","paths":["documents/a.pdf"]}),
        vec![],
    )
    .await
    .unwrap();
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    let target = out.path().join("archive.zip");
    action(&runtime, json!({"action":"target","path":target}), vec![])
        .await
        .unwrap();
    action(&runtime, json!({"action":"publish","single":null}), vec![])
        .await
        .unwrap();
    let archive = zip::ZipArchive::new(fs::File::open(&target).unwrap()).unwrap();
    let names: Vec<_> = archive.file_names().collect();
    assert_eq!(names, ["documents/", "empty/", "documents/a.pdf"]);
    let bytes = fs::read(&target).unwrap();
    assert!(action(
        &runtime,
        json!({"action":"write","path":"late","resource":false}),
        vec![3]
    )
    .await
    .is_err());
    assert!(
        action(&runtime, json!({"action":"publish","single":null}), vec![])
            .await
            .is_err()
    );
    assert_eq!(fs::read(&target).unwrap(), bytes);
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn recovers_committed_receipt_without_replacing_target_or_unowned_temporary() {
    let (data, root, out, runtime) = fixture().await;
    let jobs = data.path().join("export-jobs");
    let previous = jobs.join("job-crash");
    fs::create_dir_all(&previous).unwrap();
    let target = out.path().join("complete.zip");
    fs::write(&target, b"already committed").unwrap();
    let (hash, bytes) = export_file_hash(&target, &mut |_| Ok(())).unwrap();
    let owned = out.path().join(".noemori-export-owned");
    let unrelated = out.path().join("unrelated");
    fs::hard_link(&target, &owned).unwrap();
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(&owned).unwrap();
        json!({"device":metadata.dev(),"inode":metadata.ino()})
    };
    #[cfg(not(unix))]
    let identity = json!({});
    fs::write(&unrelated, b"keep").unwrap();
    fs::write(
        previous.join("receipt.json"),
        serde_json::to_vec(
            &json!({"version":1,"id":"previous-crash","target":target,"temporary":owned,"temporaryIdentity":identity,"hash":hash,"bytes":bytes}),
        )
        .unwrap(),
    )
    .unwrap();
    prepare(&runtime, root.path(), OperationControl::default()).await;
    assert!(!previous.exists());
    assert!(!owned.exists());
    assert_eq!(fs::read(&target).unwrap(), b"already committed");
    assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
    let recovered: Value =
        serde_json::from_slice(&fs::read(jobs.join("pending-previous-crash.json")).unwrap())
            .unwrap();
    assert_eq!(recovered["target"], target.to_str().unwrap());
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn recovery_never_deletes_a_replaced_temporary_or_infers_commit_from_old_equal_bytes() {
    use std::os::unix::fs::MetadataExt;
    let (data, _root, out, runtime) = fixture().await;
    let jobs = data.path().join("export-jobs");
    let previous = jobs.join("job-interrupted");
    fs::create_dir_all(&previous).unwrap();
    let target = out.path().join("existing.bin");
    let temporary = out.path().join(".noemori-export-replaced");
    fs::write(&target, b"same bytes").unwrap();
    fs::write(&temporary, b"same bytes").unwrap();
    let metadata = fs::metadata(&temporary).unwrap();
    let (hash, bytes) = export_file_hash(&temporary, &mut |_| Ok(())).unwrap();
    fs::write(
        previous.join("receipt.json"),
        serde_json::to_vec(&json!({
            "version":1,"id":"interrupted","target":target,"temporary":temporary,"hash":hash,"bytes":bytes,
            "temporaryIdentity":{"device":metadata.dev(),"inode":metadata.ino()}
        }))
        .unwrap(),
    )
    .unwrap();
    let replacement = out.path().join("external");
    fs::write(&replacement, b"unrelated temporary").unwrap();
    fs::rename(&replacement, &temporary).unwrap();
    let recovered = serde_json::to_value(recovery::recover(&jobs).unwrap()).unwrap();
    assert_eq!(fs::read(&temporary).unwrap(), b"unrelated temporary");
    assert_eq!(fs::read(&target).unwrap(), b"same bytes");
    assert_eq!(
        recovered,
        json!([{ "id": "interrupted", "path": target, "status": "unconfirmed" }])
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn export_protocol_rejects_invalid_identity_and_illegal_task_transitions() {
    let (_data, root, _out, runtime) = fixture().await;
    for id in [String::new(), "bad/id".into(), "x".repeat(101)] {
        let path = root.path().to_string_lossy().into_owned();
        assert!(runtime
            .write(true, move |state| state.export_prepare(
                &path,
                id,
                None,
                false,
                OperationControl::default()
            ))
            .wait()
            .await
            .unwrap()
            .is_err());
    }
    assert!(action(&runtime, json!({"action":"info"}), vec![])
        .await
        .is_err());
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    action(&runtime, json!({"action":"preserve"}), vec![])
        .await
        .unwrap();
    prepare(&runtime, root.path(), OperationControl::default()).await;
    let path = root.path().to_string_lossy().into_owned();
    assert!(runtime
        .write(true, move |state| state.export_prepare(
            &path,
            "duplicate".into(),
            None,
            false,
            OperationControl::default()
        ))
        .wait()
        .await
        .unwrap()
        .is_err());
    assert!(runtime
        .write(false, |state| state.export_action(
            "another-job",
            json!({"action":"discard"}),
            &[]
        ))
        .wait()
        .await
        .unwrap()
        .is_err());
    for command in [
        json!({"action":"unknown"}),
        json!({"action":"info","extra":true}),
        json!({"action":"write","resource":false}),
    ] {
        assert!(action(&runtime, command, vec![]).await.is_err());
    }
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn export_enforces_seal_and_single_commit_boundaries() {
    let (_data, root, out, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    action(
        &runtime,
        json!({"action":"write","path":"a.pdf","resource":false}),
        b"complete".to_vec(),
    )
    .await
    .unwrap();
    assert!(action(
        &runtime,
        json!({"action":"write","path":"a.pdf","resource":false}),
        vec![]
    )
    .await
    .is_err());
    assert!(action(
        &runtime,
        json!({"action":"retain","paths":["unknown"]}),
        vec![]
    )
    .await
    .is_err());
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    assert!(
        action(&runtime, json!({"action":"include","path":"a.md"}), vec![])
            .await
            .is_err()
    );
    assert!(action(
        &runtime,
        json!({"action":"write","path":"resource","resource":true}),
        vec![1]
    )
    .await
    .is_err());
    assert!(action(
        &runtime,
        json!({"action":"publish","single":"a.pdf"}),
        vec![]
    )
    .await
    .is_err());
    let target = out.path().join("result.pdf");
    action(&runtime, json!({"action":"target","path":target}), vec![])
        .await
        .unwrap();
    assert!(action(
        &runtime,
        json!({"action":"publish","single":"unknown"}),
        vec![]
    )
    .await
    .is_err());
    action(
        &runtime,
        json!({"action":"publish","single":"a.pdf"}),
        vec![],
    )
    .await
    .unwrap();
    for command in [
        json!({"action":"publish","single":"a.pdf"}),
        json!({"action":"write","path":"late","resource":false}),
        json!({"action":"target","path":out.path().join("late")}),
    ] {
        assert!(action(&runtime, command, vec![]).await.is_err());
    }
    assert_eq!(
        action(&runtime, json!({"action":"info"}), vec![])
            .await
            .unwrap()["sealed"],
        true
    );
    assert_eq!(fs::read(&target).unwrap(), b"complete");
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn export_dependencies_resolve_from_frozen_catalog_and_check_output_integrity() {
    let (_data, root, _out, runtime) = fixture().await;
    fs::create_dir(root.path().join("one")).unwrap();
    fs::create_dir(root.path().join("two")).unwrap();
    fs::write(root.path().join("one/b.md"), "one").unwrap();
    fs::write(root.path().join("two/b.md"), "two").unwrap();
    let path = root.path().to_string_lossy().into_owned();
    runtime
        .write(true, move |state| {
            state.export_prepare(
                &path,
                "test-job".into(),
                Some(vec!["a.md".into()]),
                false,
                OperationControl::default(),
            )
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    for (raw, expected) in [("a", "resolved"), ("b", "ambiguous"), ("missing", "dead")] {
        let value = action(
            &runtime,
            json!({"action":"resolve","from":"a.md","raw":raw,"kind":"wiki"}),
            vec![],
        )
        .await
        .unwrap();
        assert_eq!(value["status"], expected);
    }
    assert!(action(
        &runtime,
        json!({"action":"resolve","from":"a.md","raw":"b","kind":"unknown"}),
        vec![]
    )
    .await
    .is_err());
    let info = action(
        &runtime,
        json!({"action":"include","path":"one/b.md"}),
        vec![],
    )
    .await
    .unwrap();
    assert_eq!(info["files"].as_array().unwrap().len(), 2);
    action(
        &runtime,
        json!({"action":"write","path":"remote","resource":true}),
        vec![1, 2, 3],
    )
    .await
    .unwrap();
    let info = action(&runtime, json!({"action":"info"}), vec![])
        .await
        .unwrap();
    assert_eq!(info["resources"], 1);
    assert_eq!(info["resourceBytes"], 3);
    assert!(action(
        &runtime,
        json!({"action":"copy","source":"two/b.md","path":"outside"}),
        vec![]
    )
    .await
    .is_err());
    let source = Path::new(info["sourceDirectory"].as_str().unwrap()).join("a.md");
    fs::write(&source, "tampered source").unwrap();
    assert!(action(
        &runtime,
        json!({"action":"copy","source":"a.md","path":"broken"}),
        vec![]
    )
    .await
    .is_err());
    let occupied = Path::new(info["outputDirectory"].as_str().unwrap()).join("occupied");
    fs::write(&occupied, "external").unwrap();
    assert!(action(
        &runtime,
        json!({"action":"write","path":"occupied","resource":false}),
        vec![1]
    )
    .await
    .is_err());
    assert_eq!(fs::read(&occupied).unwrap(), b"external");
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn export_preserves_unknown_outcome_for_recovery_and_serializes_runtime_ownership() {
    let (data, root, _out, runtime) = fixture().await;
    let control = OperationControl::default();
    assert!(control.cancel());
    let path = root.path().to_string_lossy().into_owned();
    assert!(runtime
        .write(true, move |state| state.export_prepare(
            &path,
            "test-job".into(),
            None,
            true,
            control
        ))
        .wait()
        .await
        .unwrap()
        .is_err());
    prepare(&runtime, root.path(), OperationControl::default()).await;
    let second = Runtime::new(data.path().into(), |_| {});
    let path = root.path().to_string_lossy().into_owned();
    second
        .write(false, move |state| {
            state.open(&path, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let path = root.path().to_string_lossy().into_owned();
    assert!(second
        .write(true, move |state| state.export_prepare(
            &path,
            "other".into(),
            None,
            true,
            OperationControl::default()
        ))
        .wait()
        .await
        .unwrap()
        .is_err());
    let info = action(&runtime, json!({"action":"info"}), vec![])
        .await
        .unwrap();
    let output = Path::new(info["outputDirectory"].as_str().unwrap());
    action(&runtime, json!({"action":"preserve"}), vec![])
        .await
        .unwrap();
    assert!(output.exists());
    prepare(&runtime, root.path(), OperationControl::default()).await;
    assert!(!output.exists());
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    second.shutdown().await.unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn export_restart_reports_committed_result_until_delivery_is_acknowledged() {
    let (data, root, out, runtime) = fixture().await;
    prepare(&runtime, root.path(), OperationControl::default()).await;
    action(
        &runtime,
        json!({"action":"copy","source":"a.md","path":"a.md"}),
        vec![],
    )
    .await
    .unwrap();
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    let target = out.path().join("a.md");
    action(&runtime, json!({"action":"target","path":target}), vec![])
        .await
        .unwrap();
    action(
        &runtime,
        json!({"action":"publish","single":"a.md"}),
        vec![],
    )
    .await
    .unwrap();
    // 模拟最终回复尚未抵达窗口就正常关闭，不能依赖崩溃留下 TempDir 才能恢复。
    runtime.shutdown().await.unwrap();
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
    assert_eq!(
        reopened
            .write(false, State::export_recover)
            .wait()
            .await
            .unwrap()
            .unwrap(),
        recovered
    );
    action(&reopened, json!({"action":"acknowledge"}), vec![])
        .await
        .unwrap();
    assert_eq!(
        reopened
            .write(false, State::export_recover)
            .wait()
            .await
            .unwrap()
            .unwrap(),
        json!([])
    );
    assert_eq!(fs::read(target).unwrap(), "# 原文\n".as_bytes());
    reopened.shutdown().await.unwrap();
}
