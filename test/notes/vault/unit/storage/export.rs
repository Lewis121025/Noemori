use noemori_vault::{LinkKind, LinkTarget, Vault};
use std::fs;
use tempfile::TempDir;

fn setup() -> (TempDir, TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let user_data = TempDir::new().unwrap();
    let stage = TempDir::new().unwrap();
    fs::create_dir_all(root.path().join("notes/empty")).unwrap();
    fs::create_dir_all(root.path().join(".noemori")).unwrap();
    fs::write(
        root.path().join("notes/a.md"),
        b"\xef\xbb\xbf# Alpha\r\n\r\n[[b]]\r\n",
    )
    .unwrap();
    fs::write(root.path().join("b.md"), "---\naliases: [Beta]\n---\n# B\n").unwrap();
    fs::write(
        root.path().join(".noemori/bookmarks.json"),
        r#"{"version":1,"items":[]}"#,
    )
    .unwrap();
    let vault = Vault::open(root.path(), user_data.path()).unwrap();
    (root, user_data, stage, vault)
}

#[test]
fn export_counts_distinct_files_after_duplicate_selection_not_request_items() {
    let (_root, _state, stage, vault) = setup();
    let snapshot = vault
        .export_snapshot(
            Some(vec!["notes/a.md".into(); 10_001]),
            false,
            stage.path(),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(snapshot.files().len(), 1);
}

#[test]
fn export_preserves_deep_legal_folders_without_an_unconfirmed_depth_limit() {
    let (root, _state, stage, vault) = setup();
    let path = format!("{}deep.md", "d/".repeat(140));
    fs::create_dir_all(root.path().join(&path).parent().unwrap()).unwrap();
    fs::write(root.path().join(&path), b"deep content").unwrap();
    let mut snapshot = vault
        .export_snapshot(None, true, stage.path(), &mut |_| Ok(()))
        .unwrap();
    snapshot.seal(&vault, &mut |_| Ok(())).unwrap();
    assert_eq!(
        fs::read(snapshot.file_path(&path).unwrap()).unwrap(),
        b"deep content"
    );
}

#[test]
fn export_root_replaced_by_symlink_cannot_import_an_outside_dependency() {
    let (root, _state, stage, vault) = setup();
    let outside = TempDir::new().unwrap();
    fs::write(
        outside.path().join("external.bin"),
        "outside must not be read",
    )
    .unwrap();
    let mut snapshot = vault
        .export_snapshot(
            Some(vec!["notes/a.md".into()]),
            true,
            stage.path(),
            &mut |_| Ok(()),
        )
        .unwrap();
    let original = stage.path().join("original-root");
    fs::rename(root.path(), &original).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path()).unwrap();
    let result = snapshot.include(&vault, "external.bin", &mut |_| Ok(()));
    fs::remove_file(root.path()).unwrap();
    fs::rename(original, root.path()).unwrap();
    assert!(result.is_err(), "根目录置换不能获得库外文件读取能力");
    assert!(!snapshot
        .files()
        .iter()
        .any(|file| file.path == "external.bin"));
}

#[test]
fn export_preserves_original_bytes_hidden_files_and_empty_directories() {
    let (root, _state, stage, vault) = setup();
    let mut snapshot = vault
        .export_snapshot(None, true, stage.path(), &mut |_| Ok(()))
        .unwrap();
    assert_eq!(snapshot.files().len(), 3);
    assert!(snapshot.directories().contains(&"notes/empty".into()));
    snapshot.seal(&vault, &mut |_| Ok(())).unwrap();
    for entry in snapshot.files() {
        assert_eq!(
            fs::read(root.path().join(&entry.path)).unwrap(),
            fs::read(snapshot.file_path(&entry.path).unwrap()).unwrap()
        );
    }
    assert!(snapshot.include(&vault, "b.md", &mut |_| Ok(())).is_err());
}

#[test]
fn export_deduplicates_selection_and_dependencies_and_freezes_link_identity() {
    let (_root, _state, stage, vault) = setup();
    let mut snapshot = vault
        .export_snapshot(
            Some(vec!["notes".into(), "notes/a.md".into()]),
            true,
            stage.path(),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(snapshot.files().len(), 1);
    assert!(
        matches!(snapshot.resolve("notes/a.md", "Beta", LinkKind::Wiki), LinkTarget::Resolved { path, .. } if path == "b.md")
    );
    snapshot.include(&vault, "b.md", &mut |_| Ok(())).unwrap();
    snapshot.include(&vault, "b.md", &mut |_| Ok(())).unwrap();
    assert_eq!(snapshot.files().len(), 2);
    snapshot.seal(&vault, &mut |_| Ok(())).unwrap();
}

#[test]
fn export_resolves_saved_aliases_without_trusting_stale_index_and_rejects_later_changes() {
    let (root, _state, stage, vault) = setup();
    fs::write(
        root.path().join("b.md"),
        "---\naliases: [Current]\n---\n# B\n",
    )
    .unwrap();
    let mut snapshot = vault
        .export_snapshot(
            Some(vec!["notes/a.md".into()]),
            false,
            stage.path(),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert!(
        matches!(snapshot.resolve("notes/a.md", "Current", LinkKind::Wiki), LinkTarget::Resolved { path, .. } if path == "b.md")
    );
    fs::write(
        root.path().join("b.md"),
        "---\naliases: [Changed]\n---\n# B\n",
    )
    .unwrap();
    assert!(snapshot.seal(&vault, &mut |_| Ok(())).is_err());
}

#[test]
fn export_rejects_concurrent_content_changes_and_new_entries() {
    for change_directory in [false, true] {
        let (root, _state, stage, vault) = setup();
        let mut snapshot = vault
            .export_snapshot(None, true, stage.path(), &mut |_| Ok(()))
            .unwrap();
        fs::write(
            root.path()
                .join(if change_directory { "new.md" } else { "b.md" }),
            "changed",
        )
        .unwrap();
        assert!(snapshot.seal(&vault, &mut |_| Ok(())).is_err());
    }
}

#[test]
fn export_rejects_pending_and_orphaned_recovery_without_changing_sources() {
    for path in ["b.md", "orphan.md"] {
        let (root, _state, stage, vault) = setup();
        let before = fs::read(root.path().join("b.md")).unwrap();
        vault
            .write(path, b"draft", Some(b"wrong baseline"))
            .unwrap();
        assert!(vault
            .export_snapshot(None, true, stage.path(), &mut |_| Ok(()))
            .is_err());
        assert_eq!(fs::read(root.path().join("b.md")).unwrap(), before);
        assert!(vault.snapshot(path).unwrap().draft.is_some());
    }
}

#[test]
fn export_rejects_escape_symlinks_and_cancelled_copy() {
    let (root, _state, stage, vault) = setup();
    for paths in [vec![], vec!["../outside".into()], vec!["/absolute".into()]] {
        assert!(vault
            .export_snapshot(Some(paths), true, stage.path(), &mut |_| Ok(()))
            .is_err());
    }
    assert!(vault
        .export_snapshot(None, true, stage.path(), &mut |_| Err(
            noemori_vault::Error::Io(std::io::Error::other("cancelled"))
        ))
        .is_err());
    assert_eq!(fs::read_dir(stage.path()).unwrap().count(), 0);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(stage.path(), root.path().join("linked")).unwrap();
        assert!(vault
            .export_snapshot(None, true, stage.path(), &mut |_| Ok(()))
            .is_err());
    }
}

#[test]
fn export_validates_selection_order_independence_for_one_thousand_permutations() {
    let (root, _state, stage, vault) = setup();
    let files = [
        "b.md",
        "notes/a.md",
        "notes/中文.md",
        "notes/spaces name.md",
        "other/emoji😀.md",
        "other/crlf.md",
    ];
    fs::create_dir(root.path().join("other")).unwrap();
    for path in &files[2..] {
        fs::write(root.path().join(path), format!("# {path}\r\n\r\n原文\n")).unwrap();
    }
    let candidates = [
        "b.md",
        "notes/a.md",
        "notes/中文.md",
        "notes/spaces name.md",
        "other/emoji😀.md",
        "other/crlf.md",
        "notes",
        "other",
    ];
    let mut random = 19_491_001_u32;
    for _ in 0..1000 {
        random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let mut selected: Vec<String> = candidates
            .iter()
            .enumerate()
            .filter(|(index, _)| random & (1 << index) != 0)
            .map(|(_, path)| (*path).to_string())
            .collect();
        if selected.is_empty() {
            selected.push("b.md".into());
        }
        let mut expected: Vec<_> = files
            .iter()
            .filter(|path| {
                selected
                    .iter()
                    .any(|chosen| *path == chosen || path.starts_with(&format!("{chosen}/")))
            })
            .copied()
            .collect();
        expected.sort_unstable();
        let first = vault
            .export_snapshot(Some(selected.clone()), false, stage.path(), &mut |_| Ok(()))
            .unwrap();
        selected.reverse();
        selected.push(selected[0].clone());
        let second = vault
            .export_snapshot(Some(selected), false, stage.path(), &mut |_| Ok(()))
            .unwrap();
        let signatures = |snapshot: &noemori_vault::export::ExportSnapshot| {
            snapshot
                .files()
                .into_iter()
                .map(|entry| (entry.path, entry.hash, entry.bytes))
                .collect::<Vec<_>>()
        };
        assert_eq!(signatures(&first), signatures(&second));
        assert_eq!(
            first
                .files()
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            expected
        );
        for entry in first.files() {
            assert_eq!(
                fs::read(first.file_path(&entry.path).unwrap()).unwrap(),
                fs::read(root.path().join(entry.path)).unwrap()
            );
        }
    }
}
