//! 应用仓库以真实文件验证导入副本、恢复现场及失败时的提交边界。
use noemori_runtime::{OperationControl, Runtime};
use serde_json::json;
use std::fs;

#[tokio::test(flavor = "multi_thread")]
async fn first_launch_creates_the_application_library() {
    let data = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory
        .path()
        .join("Noemori")
        .to_str()
        .unwrap()
        .to_owned();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let request = root.clone();
    let restored = runtime
        .write(false, move |state| {
            state.restore_library(&request, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored["root"], root);
    assert!(restored["entries"].as_array().unwrap().is_empty());
    assert_eq!(
        runtime
            .write(false, |state| state.sessions.load())
            .wait()
            .await
            .unwrap()["reader"]["vaultRoot"],
        root
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_library_becomes_a_child_and_restores_documents_and_drafts() {
    let data = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("研究");
    fs::create_dir_all(source.join("章节")).unwrap();
    fs::write(
        source.join("章节/笔记.md"),
        "# 原文\n\n[图片](../图片.png)\n",
    )
    .unwrap();
    fs::write(source.join("图片.png"), [0, 1, 2, 255]).unwrap();
    let old = source.to_str().unwrap().to_owned();
    let root = directory
        .path()
        .join("Noemori")
        .to_str()
        .unwrap()
        .to_owned();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let request = old.clone();
    runtime
        .write(false, move |state| {
            state.open(&request, false, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    runtime.write(true, |state| {
        state.vault().unwrap().preserve_editor_draft("章节/笔记.md", b"# draft", Some("# 原文\n\n[图片](../图片.png)\n".as_bytes()), "editor-recovery").unwrap();
        state.sessions.patch_reader(&json!({"currentPath":"章节/笔记.md", "documents":{"panes":[{"currentPath":"章节/笔记.md","history":{"back":[{"path":"章节/笔记.md","anchor":"原文"}],"forward":[]}}],"active":0,"split":false},"recentFiles":["章节/笔记.md"],"viewModes":{"章节/笔记.md":"source"},"fileTree":{"expanded":["章节"],"selected":["章节/笔记.md"],"focused":"章节/笔记.md"}}))
    }).wait().await.unwrap().unwrap();
    let request = root.clone();
    let restored = runtime
        .write(false, move |state| {
            state.restore_library(&request, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored["root"], root);
    assert_eq!(
        restored["documents"]["panes"][0]["currentPath"],
        "研究/章节/笔记.md"
    );
    assert_eq!(
        restored["documents"]["panes"][0]["history"]["back"][0]["path"],
        "研究/章节/笔记.md"
    );
    assert_eq!(restored["recentFiles"], json!(["研究/章节/笔记.md"]));
    assert_eq!(restored["viewModes"]["研究/章节/笔记.md"], "source");
    let draft = runtime
        .read(|vault| vault.snapshot("研究/章节/笔记.md"))
        .wait()
        .await
        .unwrap()
        .unwrap()
        .draft
        .unwrap();
    assert_eq!(draft.bytes, b"# draft");
    assert_eq!(draft.editor.as_deref(), Some("editor-recovery"));
    assert_eq!(
        fs::read(source.join("图片.png")).unwrap(),
        fs::read(std::path::Path::new(&root).join("研究/图片.png")).unwrap()
    );
    assert!(source.join("章节/笔记.md").is_file());
    let request = root.clone();
    runtime
        .write(false, move |state| {
            state.create(&request, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        runtime
            .write(false, |state| state.sessions.load())
            .wait()
            .await
            .unwrap()["reader"]["documents"]["panes"][0]["currentPath"],
        "研究/章节/笔记.md"
    );
    let request = root.clone();
    runtime
        .write(false, move |state| {
            state.restore_library(&request, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert!(!std::path::Path::new(&root).join("研究 (2)").exists());
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn imports_keep_multiple_directories_and_create_unique_copies() {
    let data = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("资料");
    fs::create_dir_all(source.join("空目录")).unwrap();
    fs::write(source.join("笔记.md"), "完整副本").unwrap();
    let root = directory
        .path()
        .join("Noemori")
        .to_str()
        .unwrap()
        .to_owned();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let request = root.clone();
    runtime
        .write(false, move |state| {
            state.restore_library(&request, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    for suffix in ["资料", "资料 (2)"] {
        let request = root.clone();
        let from = source.to_str().unwrap().to_owned();
        let imported = runtime
            .write(true, move |state| {
                state.import_directory(&request, &from, "", &OperationControl::default())
            })
            .wait()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(imported["path"], suffix);
        assert!(
            std::path::Path::new(&root)
                .join(suffix)
                .join("空目录")
                .is_dir()
        );
        assert_eq!(
            fs::read_to_string(std::path::Path::new(&root).join(suffix).join("笔记.md")).unwrap(),
            "完整副本"
        );
    }
    assert_eq!(
        fs::read_to_string(source.join("笔记.md")).unwrap(),
        "完整副本"
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_and_invalid_destinations_leave_no_partial_import() {
    let data = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("资料");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("笔记.md"), "原文").unwrap();
    let root = directory
        .path()
        .join("Noemori")
        .to_str()
        .unwrap()
        .to_owned();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let request = root.clone();
    runtime
        .write(false, move |state| {
            state.restore_library(&request, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let control = OperationControl::default();
    assert!(control.cancel());
    let request = root.clone();
    let from = source.to_str().unwrap().to_owned();
    assert!(
        runtime
            .write(true, move |state| state
                .import_directory(&request, &from, "", &control))
            .wait()
            .await
            .unwrap()
            .unwrap()
            .is_null()
    );
    let request = root.clone();
    let from = source.to_str().unwrap().to_owned();
    assert!(
        runtime
            .write(true, move |state| state.import_directory(
                &request,
                &from,
                "../外部",
                &OperationControl::default()
            ))
            .wait()
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn import_into_a_child_preserves_modification_time_and_rejects_stale_roots() {
    let data = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("资料");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("笔记.md"), "原文").unwrap();
    let modified = fs::metadata(source.join("笔记.md"))
        .unwrap()
        .modified()
        .unwrap();
    let root = directory
        .path()
        .join("Noemori")
        .to_str()
        .unwrap()
        .to_owned();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let request = root.clone();
    runtime
        .write(false, move |state| {
            state.restore_library(&request, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    runtime
        .write(true, |state| {
            state.create_entry("研究", noemori_vault::EntryKind::Directory, &[])
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let request = root.clone();
    let from = source.to_str().unwrap().to_owned();
    let imported = runtime
        .write(true, move |state| {
            state.import_directory(&request, &from, "研究", &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(imported["path"], "研究/资料");
    assert_eq!(
        fs::metadata(std::path::Path::new(&root).join("研究/资料/笔记.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    let from = source.to_str().unwrap().to_owned();
    assert!(
        runtime
            .write(true, move |state| state.import_directory(
                "/other",
                &from,
                "",
                &OperationControl::default()
            ))
            .wait()
            .await
            .unwrap()
            .is_err()
    );
    runtime.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn symbolic_links_and_recursive_sources_fail_without_publishing() {
    let data = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("资料");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("笔记.md"), "原文").unwrap();
    std::os::unix::fs::symlink("笔记.md", source.join("链接.md")).unwrap();
    let root = directory
        .path()
        .join("Noemori")
        .to_str()
        .unwrap()
        .to_owned();
    let runtime = Runtime::new(data.path().into(), |_| {});
    let request = root.clone();
    runtime
        .write(false, move |state| {
            state.restore_library(&request, &OperationControl::default())
        })
        .wait()
        .await
        .unwrap()
        .unwrap();
    let request = root.clone();
    let from = source.to_str().unwrap().to_owned();
    assert!(
        runtime
            .write(true, move |state| state.import_directory(
                &request,
                &from,
                "",
                &OperationControl::default()
            ))
            .wait()
            .await
            .unwrap()
            .is_err()
    );
    let request = root.clone();
    let from = directory.path().to_str().unwrap().to_owned();
    assert!(
        runtime
            .write(true, move |state| state.import_directory(
                &request,
                &from,
                "",
                &OperationControl::default()
            ))
            .wait()
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    runtime.shutdown().await.unwrap();
}
