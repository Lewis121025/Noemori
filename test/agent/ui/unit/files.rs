#[path = "../../../../modules/agent/src/tool/ui/files.rs"]
mod files;

#[cfg(unix)]
#[test]
fn uploads_freeze_bytes_and_reject_workspace_escape_or_private_material() {
    use base64::Engine;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let private = root.path().join("private");
    std::fs::create_dir(&private).unwrap();
    std::fs::write(private.join("connection.json"), "secret").unwrap();
    std::fs::write(root.path().join("input.txt"), "中文原字节").unwrap();
    std::fs::write(outside.path().join("outside.txt"), "外部").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("outside.txt"),
        root.path().join("alias"),
    )
    .unwrap();
    let boundary = files::UiFiles::new(root.path().into(), private.clone()).unwrap();
    let frozen = boundary.upload(&["input.txt".into()]).unwrap();
    std::fs::write(root.path().join("input.txt"), "后来内容").unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(&frozen[0].data)
            .unwrap(),
        "中文原字节".as_bytes()
    );
    assert!(boundary.upload(&["alias".into()]).is_err());
    assert!(
        boundary
            .upload(&[outside.path().join("outside.txt").to_string_lossy().into()])
            .is_err()
    );
    assert!(
        boundary
            .upload(&["private/connection.json".into()])
            .is_err()
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn non_regular_upload_does_not_block_before_type_validation() {
    let root = tempfile::tempdir().unwrap();
    let pipe = root.path().join("pipe");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap()
            .success()
    );
    let boundary = files::UiFiles::new(root.path().into(), root.path().join("private")).unwrap();
    let (reply, read) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = reply.send(boundary.upload(&["pipe".into()]));
    });
    let result = tokio::time::timeout(std::time::Duration::from_millis(300), read)
        .await
        .expect("非普通文件不能挂起宿主文件入口")
        .unwrap();
    assert!(result.is_err());
}

#[cfg(unix)]
#[test]
fn files_obey_aggregate_limit_and_saving_never_overwrites() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let boundary = files::UiFiles::new(root.path().into(), root.path().join("private")).unwrap();
    let big = std::fs::File::create(root.path().join("large")).unwrap();
    big.set_len(files::FILE_LIMIT as u64 + 1).unwrap();
    assert!(boundary.upload(&["large".into()]).is_err());
    std::fs::write(source.path().join("download"), "完整内容").unwrap();
    boundary
        .save(&source.path().join("download"), "saved.txt")
        .unwrap();
    assert!(
        boundary
            .save(&source.path().join("download"), "saved.txt")
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("saved.txt")).unwrap(),
        "完整内容"
    );
    assert!(
        boundary
            .save(
                &source.path().join("download"),
                &source.path().join("escape").to_string_lossy()
            )
            .is_err()
    );
    assert!(!std::fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".nui-")
    }));
}
