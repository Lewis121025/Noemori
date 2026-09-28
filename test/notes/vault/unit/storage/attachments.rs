use nous_vault::{Vault, MAX_ATTACHMENT_BYTES};
use std::fs;
use tempfile::TempDir;

fn setup() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    fs::create_dir(root.path().join("资料")).unwrap();
    fs::write(root.path().join("资料/笔记.md"), "原文\r\n").unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    (root, state, vault)
}

#[test]
fn imports_original_bytes_beside_note_and_preserves_collisions() {
    let (root, _state, vault) = setup();
    let bytes = [0, 255, 239, 187, 191, 13, 10];
    for (name, expected) in [
        ("图片 #1.png", "资料/attachments/图片 #1.png"),
        ("图片 #1.png", "资料/attachments/图片 #1 (1).png"),
        ("图片 #1.png", "资料/attachments/图片 #1 (2).png"),
        ("无扩展名", "资料/attachments/无扩展名"),
    ] {
        let result = vault
            .import_attachment("资料/笔记.md", name, &bytes)
            .unwrap();
        assert_eq!(result.path, expected);
        assert_eq!(result.warning, None);
        assert_eq!(fs::read(root.path().join(expected)).unwrap(), bytes);
        assert!(vault.list_files().unwrap().contains(&expected.to_owned()));
    }
    assert_eq!(vault.read("资料/笔记.md").unwrap(), "原文\r\n".as_bytes());
    assert!(vault.snapshot("资料/笔记.md").unwrap().draft.is_none());
}

#[test]
fn rejects_invalid_names_missing_notes_and_oversize_before_writing() {
    let (root, _state, vault) = setup();
    for name in [
        "",
        "../outside.png",
        "sub/file.png",
        ".hidden",
        "CON.txt",
        "x\\y",
        " name",
    ] {
        assert!(
            vault.import_attachment("资料/笔记.md", name, b"x").is_err(),
            "{name}"
        );
    }
    for note in ["../outside.md", "资料/missing.md", "资料"] {
        assert!(
            vault.import_attachment(note, "x.png", b"x").is_err(),
            "{note}"
        );
    }
    assert!(vault
        .import_attachment("资料/笔记.md", "large", &vec![0; MAX_ATTACHMENT_BYTES + 1])
        .is_err());
    assert!(!root.path().join("资料/attachments").exists());
}

#[test]
fn reserves_recovery_paths_and_rejects_blocked_directory() {
    let (root, _state, vault) = setup();
    vault
        .write("资料/attachments/x.png", b"draft", Some(b"missing"))
        .unwrap();
    let imported = vault
        .import_attachment("资料/笔记.md", "x.png", b"new")
        .unwrap();
    assert_eq!(imported.path, "资料/attachments/x (1).png");
    assert_eq!(
        vault
            .snapshot("资料/attachments/x.png")
            .unwrap()
            .draft
            .unwrap()
            .bytes,
        b"draft"
    );
    fs::create_dir(root.path().join("资料/attachments/dir.png")).unwrap();
    assert_eq!(
        vault
            .import_attachment("资料/笔记.md", "dir.png", b"new")
            .unwrap()
            .path,
        "资料/attachments/dir (1).png"
    );
    fs::remove_dir_all(root.path().join("资料/attachments")).unwrap();
    fs::write(root.path().join("资料/attachments"), b"existing").unwrap();
    assert!(vault
        .import_attachment("资料/笔记.md", "x.png", b"new")
        .is_err());
    assert_eq!(vault.read("资料/attachments").unwrap(), b"existing");
}

#[test]
fn directory_draft_blocks_import_and_index_failure_reports_committed_path() {
    let (root, state, vault) = setup();
    vault
        .write("资料/attachments", b"recoverable", Some(b"deleted"))
        .unwrap();
    assert!(vault
        .import_attachment("资料/笔记.md", "x.png", b"new")
        .is_err());
    assert!(!root.path().join("资料/attachments").exists());
    fs::write(root.path().join("other.md"), b"note").unwrap();
    let conn = rusqlite::Connection::open(state.path().join("index.sqlite")).unwrap();
    conn.execute("DROP TABLE links", []).unwrap();
    let result = vault
        .import_attachment("other.md", "x.png", b"new")
        .unwrap();
    assert_eq!(result.path, "attachments/x.png");
    assert!(result.warning.unwrap().contains("索引刷新失败"));
    assert_eq!(vault.read(&result.path).unwrap(), b"new");
}

#[test]
#[cfg(unix)]
fn rejects_symlink_directory_and_skips_symlink_filename() {
    use std::os::unix::fs::symlink;
    let (root, _state, vault) = setup();
    let outside = TempDir::new().unwrap();
    let directory = root.path().join("资料/attachments");
    symlink(outside.path(), &directory).unwrap();
    assert!(vault
        .import_attachment("资料/笔记.md", "x.png", b"new")
        .is_err());
    assert!(!outside.path().join("x.png").exists());
    fs::remove_file(&directory).unwrap();
    fs::create_dir(&directory).unwrap();
    symlink(outside.path().join("missing"), directory.join("x.png")).unwrap();
    assert_eq!(
        vault
            .import_attachment("资料/笔记.md", "x.png", b"new")
            .unwrap()
            .path,
        "资料/attachments/x (1).png"
    );
    assert!(directory.join("x.png").is_symlink());
}

#[test]
fn concurrent_imports_reserve_distinct_names_and_keep_each_payload() {
    let (_root, _state, vault) = setup();
    std::thread::scope(|scope| {
        let imports: Vec<_> = (0..6_u8)
            .map(|value| {
                let vault = &vault;
                scope.spawn(move || {
                    let result = vault
                        .import_attachment("资料/笔记.md", "same.bin", &[value])
                        .unwrap();
                    assert_eq!(vault.read(&result.path).unwrap(), [value]);
                    result.path
                })
            })
            .collect();
        let paths: std::collections::HashSet<_> = imports
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(paths.len(), 6);
    });
}

#[test]
#[cfg(unix)]
fn unwritable_directory_keeps_original_and_leaves_no_partial_attachment() {
    use std::os::unix::fs::PermissionsExt;
    let (root, _state, vault) = setup();
    let directory = root.path().join("资料/attachments");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("x.png"), b"original").unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o500)).unwrap();
    let result = vault.import_attachment("资料/笔记.md", "x.png", b"new");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(directory.join("x.png")).unwrap(), b"original");
    assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
}
