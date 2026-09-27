use nous_core::{EntryKind, EntryMutation, Error, Vault};
use std::fs;
use tempfile::TempDir;

fn setup() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    (root, state, vault)
}

#[test]
fn batch_preflight_rejects_later_conflicts_without_moving_earlier_files() {
    let (root, _state, vault) = setup();
    fs::create_dir(root.path().join("target")).unwrap();
    for path in ["a.md", "b.md", "target/b.md"] {
        fs::write(root.path().join(path), path).unwrap();
    }
    let changes = vec![
        EntryMutation {
            from: "a.md".into(),
            to: Some("target/a.md".into()),
        },
        EntryMutation {
            from: "b.md".into(),
            to: Some("target/b.md".into()),
        },
    ];
    assert!(vault.check_entry_batch(&changes).is_err());
    assert_eq!(vault.read("a.md").unwrap(), b"a.md");
    assert!(!root.path().join("target/a.md").exists());
    fs::remove_file(root.path().join("target/b.md")).unwrap();
    vault.check_entry_batch(&changes).unwrap();
    assert!(root.path().join("a.md").exists());
    for change in changes {
        vault
            .rename(&change.from, change.to.as_deref().unwrap())
            .unwrap();
    }
    assert_eq!(vault.read("target/b.md").unwrap(), b"b.md");
}

#[test]
fn batch_preflight_preserves_uncommitted_drafts_and_rejects_overlapping_sources() {
    let (root, _state, vault) = setup();
    fs::create_dir(root.path().join("folder")).unwrap();
    fs::write(root.path().join("folder/a.md"), b"disk").unwrap();
    fs::write(root.path().join("b.md"), b"keep").unwrap();
    vault
        .write("folder/a.md", b"editing", Some(b"old"))
        .unwrap();
    let changes = vec![
        EntryMutation {
            from: "b.md".into(),
            to: None,
        },
        EntryMutation {
            from: "folder".into(),
            to: None,
        },
    ];
    assert!(vault
        .check_entry_batch(&changes)
        .unwrap_err()
        .to_string()
        .contains("草稿"));
    assert!(root.path().join("b.md").exists());
    assert_eq!(
        vault.snapshot("folder/a.md").unwrap().draft.unwrap().bytes,
        b"editing"
    );
    let overlapping = vec![
        EntryMutation {
            from: "folder".into(),
            to: None,
        },
        EntryMutation {
            from: "folder/a.md".into(),
            to: None,
        },
    ];
    assert!(vault
        .check_entry_batch(&overlapping)
        .unwrap_err()
        .to_string()
        .contains("重复"));
}

#[test]
fn batch_preflight_checks_path_ancestors_without_confusing_name_prefixes() {
    let (root, _state, vault) = setup();
    for path in ["folder", "folder-other", "archive"] {
        fs::create_dir(root.path().join(path)).unwrap();
    }
    fs::write(root.path().join("a.md"), b"keep").unwrap();
    let mut changes = vec![
        EntryMutation {
            from: "folder".into(),
            to: Some("archive/folder".into()),
        },
        EntryMutation {
            from: "a.md".into(),
            to: Some("folder-other/a.md".into()),
        },
    ];
    vault.check_entry_batch(&changes).unwrap();
    changes[1].to = Some("folder/a.md".into());
    assert!(vault
        .check_entry_batch(&changes)
        .unwrap_err()
        .to_string()
        .contains("自身"));
    changes[1].to = Some("folder".into());
    assert!(vault.check_entry_batch(&changes).is_err());
    changes[1].to = Some("a.md/child".into());
    assert!(vault.check_entry_batch(&changes).is_err());
    assert_eq!(vault.read("a.md").unwrap(), b"keep");
    assert!(root.path().join("folder").is_dir());
    assert!(!root.path().join("archive/folder").exists());
}

#[cfg(unix)]
#[test]
fn batch_preflight_inspects_hidden_children_before_any_move() {
    use std::os::unix::fs::symlink;
    let (root, _state, vault) = setup();
    fs::create_dir(root.path().join("source")).unwrap();
    fs::create_dir(root.path().join("target")).unwrap();
    fs::write(root.path().join("a.md"), b"keep").unwrap();
    symlink(root.path().join("a.md"), root.path().join("source/.link")).unwrap();
    let changes = vec![
        EntryMutation {
            from: "a.md".into(),
            to: Some("target/a.md".into()),
        },
        EntryMutation {
            from: "source".into(),
            to: Some("target/source".into()),
        },
    ];
    assert!(vault.check_entry_batch(&changes).is_err());
    assert!(root.path().join("a.md").exists());
    assert!(!root.path().join("target/a.md").exists());
}

#[test]
fn lists_empty_directories_and_notifies_directory_only_changes() {
    let (root, _state, vault) = setup();
    fs::create_dir_all(root.path().join("项目/空目录")).unwrap();
    assert!(vault.refresh_index().unwrap());
    let entries = vault.list_entries().unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .all(|entry| entry.kind == EntryKind::Directory));
    assert!(!vault.refresh_index().unwrap());
    fs::remove_dir(root.path().join("项目/空目录")).unwrap();
    assert!(vault.refresh_index().unwrap());
}

#[test]
fn creation_is_exclusive_and_rejects_hidden_escape_and_missing_parent() {
    let (root, _state, vault) = setup();
    vault
        .create_entry("项目", EntryKind::Directory, b"")
        .unwrap();
    vault
        .create_entry("项目/笔记.md", EntryKind::File, b"")
        .unwrap();
    fs::write(root.path().join("项目/笔记.md"), "保留内容").unwrap();
    assert!(vault
        .create_entry("项目/笔记.md", EntryKind::File, b"")
        .is_err());
    assert_eq!(vault.read("项目/笔记.md").unwrap(), "保留内容".as_bytes());
    for path in [
        "../越界.md",
        "",
        ".",
        ".隐藏.md",
        "丢失/笔记.md",
        "CON.md",
        "项目/Lpt1.txt",
        " 前导空格.md",
    ] {
        assert!(
            vault.create_entry(path, EntryKind::File, b"").is_err(),
            "{path}"
        );
    }
    assert!(vault.snapshot("项目/笔记.md").unwrap().draft.is_none());
}

#[test]
fn creation_preserves_missing_parents_of_recoverable_drafts() {
    let (root, _state, vault) = setup();
    fs::create_dir(root.path().join("folder.md")).unwrap();
    fs::write(root.path().join("folder.md/note.md"), b"disk").unwrap();
    vault
        .write(
            "folder.md/note.md",
            b"recoverable editing",
            Some(b"outdated"),
        )
        .unwrap();
    fs::remove_dir_all(root.path().join("folder.md")).unwrap();
    vault.refresh_index().unwrap();

    assert!(vault
        .create_entry("folder.md", EntryKind::File, b"")
        .is_err());
    assert!(!root.path().join("folder.md").exists());
    assert_eq!(
        vault
            .snapshot("folder.md/note.md")
            .unwrap()
            .draft
            .unwrap()
            .bytes,
        b"recoverable editing"
    );
    vault
        .create_entry("folder.md", EntryKind::Directory, b"")
        .unwrap();
    assert!(root.path().join("folder.md").is_dir());
    assert!(vault
        .create_entry("folder.md/note.md", EntryKind::Directory, b"")
        .is_err());
    vault
        .create_entry("folder.md-other.md", EntryKind::File, b"")
        .unwrap();
}

#[test]
fn creation_reserves_normalized_draft_paths() {
    let (root, _state, vault) = setup();
    vault
        .write("./note.md", b"recoverable edits", Some(b"deleted"))
        .unwrap();
    for kind in [EntryKind::File, EntryKind::Directory] {
        assert!(vault.create_entry("note.md", kind, b"").is_err());
    }
    assert!(!root.path().join("note.md").exists());
    assert_eq!(
        vault.snapshot("./note.md").unwrap().draft.unwrap().bytes,
        b"recoverable edits"
    );
}

#[test]
fn rename_rejects_invisible_or_reserved_destinations_before_changing_files() {
    let (_root, _state, vault) = setup();
    vault.create_entry("笔记.md", EntryKind::File, b"").unwrap();
    for target in [".隐藏.md", "CON.md", "新建/aux.txt", "尾部."] {
        assert!(vault.rename("笔记.md", target).is_err(), "{target}");
        assert_eq!(vault.read("笔记.md").unwrap(), b"");
    }
}

#[test]
fn trash_failure_preserves_files_and_pending_drafts_block_trash() {
    let (root, _state, vault) = setup();
    vault.create_entry("笔记.md", EntryKind::File, b"").unwrap();
    let result = vault.trash_entry("笔记.md", |_| {
        Err(Error::Io(std::io::Error::other("废纸篓不可用")))
    });
    assert!(result.is_err());
    assert!(root.path().join("笔记.md").exists());
    vault
        .write("笔记.md", b"draft", Some(b"wrong base"))
        .unwrap();
    assert!(vault
        .trash_entry("笔记.md", |_| panic!("有草稿不得删除"))
        .is_err());
    assert_eq!(
        vault.snapshot("笔记.md").unwrap().draft.unwrap().bytes,
        b"draft"
    );
}

#[test]
fn blocked_draft_only_prevents_trashing_its_own_path_or_ancestors() {
    let (root, _state, vault) = setup();
    let trash = TempDir::new().unwrap();
    fs::create_dir(root.path().join("broken")).unwrap();
    fs::write(root.path().join("broken/note.md"), b"external").unwrap();
    vault
        .write("./broken/note.md", b"draft", Some(b"base"))
        .unwrap();
    fs::remove_dir_all(root.path().join("broken")).unwrap();
    fs::write(root.path().join("broken"), b"keep replacement").unwrap();
    fs::write(root.path().join("broken-other.md"), b"unrelated").unwrap();

    vault
        .trash_entry("broken-other.md", |path| {
            fs::rename(path, trash.path().join("broken-other.md")).map_err(Error::from)
        })
        .unwrap();
    assert_eq!(
        fs::read(trash.path().join("broken-other.md")).unwrap(),
        b"unrelated"
    );
    assert!(vault
        .trash_entry("broken", |_| panic!("恢复路径仍受保护"))
        .is_err());
    assert_eq!(vault.read("broken").unwrap(), b"keep replacement");
    assert_eq!(
        vault
            .snapshot("./broken/note.md")
            .unwrap()
            .draft
            .unwrap()
            .bytes,
        b"draft"
    );
}

#[test]
fn trash_updates_inventory_and_never_accepts_the_vault_root() {
    let (root, _state, vault) = setup();
    let trash = TempDir::new().unwrap();
    vault
        .create_entry("项目", EntryKind::Directory, b"")
        .unwrap();
    vault
        .create_entry("项目/笔记.md", EntryKind::File, b"")
        .unwrap();
    vault
        .trash_entry("项目", |path| {
            fs::rename(path, trash.path().join("项目")).map_err(Error::from)
        })
        .unwrap();
    assert!(!root.path().join("项目").exists());
    assert!(trash.path().join("项目/笔记.md").exists());
    assert!(vault.list_entries().unwrap().is_empty());
    assert!(vault.trash_entry(".", |_| panic!("不能删除库根")).is_err());
}

#[test]
fn folder_move_preserves_empty_and_hidden_entries_and_rewrites_links() {
    let (root, _state, vault) = setup();
    fs::create_dir_all(root.path().join("old/empty")).unwrap();
    fs::write(root.path().join("old/.hidden"), b"hidden").unwrap();
    fs::write(root.path().join("old/A.md"), "[peer](../B.md)\n").unwrap();
    fs::write(root.path().join("B.md"), "[a](old/A.md) [[A]]\n").unwrap();
    vault.refresh_index().unwrap();
    vault.rename("old", "new").unwrap();
    assert!(!root.path().join("old").exists());
    assert!(root.path().join("new/empty").is_dir());
    assert_eq!(vault.read("new/.hidden").unwrap(), b"hidden");
    assert_eq!(vault.read("new/A.md").unwrap(), b"[peer](../B.md)\n");
    assert_eq!(
        String::from_utf8(vault.read("B.md").unwrap()).unwrap(),
        "[a](./new/A.md) [[A]]\n"
    );
    assert_eq!(vault.links_to("new/A.md").unwrap().len(), 2);
}

#[test]
fn folder_move_rejects_descendant_or_existing_destination_without_changes() {
    let (root, _state, vault) = setup();
    fs::create_dir(root.path().join("old")).unwrap();
    fs::create_dir(root.path().join("exists")).unwrap();
    fs::write(root.path().join("old/A.md"), b"original").unwrap();
    assert!(vault.rename("old", "old/child").is_err());
    assert!(vault.rename("old", "exists").is_err());
    assert_eq!(vault.read("old/A.md").unwrap(), b"original");
    assert!(!root.path().join("old/child").exists());
}

#[test]
#[cfg(unix)]
fn folder_move_preserves_directory_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (root, _state, vault) = setup();
    fs::create_dir_all(root.path().join("private/empty")).unwrap();
    fs::set_permissions(
        root.path().join("private"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::set_permissions(
        root.path().join("private/empty"),
        fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    vault.rename("private", "renamed").unwrap();
    for (path, mode) in [("renamed", 0o700), ("renamed/empty", 0o750)] {
        assert_eq!(
            fs::metadata(root.path().join(path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            mode
        );
    }
}

#[test]
#[cfg(unix)]
fn symlinks_never_escape_the_vault_and_block_partial_folder_moves() {
    use std::os::unix::fs::symlink;
    let (root, _state, vault) = setup();
    let outside = TempDir::new().unwrap();
    fs::create_dir(root.path().join("folder")).unwrap();
    fs::write(outside.path().join("original.md"), b"outside").unwrap();
    symlink(outside.path(), root.path().join("folder/.linked")).unwrap();
    assert!(vault.entry_path("folder/.linked/original.md").is_err());
    assert!(vault
        .create_entry("folder/.linked/new.md", EntryKind::File, b"")
        .is_err());
    assert!(vault
        .trash_entry("folder/.linked", |_| panic!("不应传入符号链接"))
        .is_err());
    assert!(vault.rename("folder", "moved").is_err());
    assert!(!root.path().join("moved").exists());
    assert!(root.path().join("folder/.linked").is_symlink());
    assert_eq!(
        fs::read(outside.path().join("original.md")).unwrap(),
        b"outside"
    );
}

#[test]
#[cfg(unix)]
fn special_files_do_not_break_browsing_but_prevent_incomplete_folder_moves() {
    use std::os::unix::net::UnixListener;
    let (root, _state, vault) = setup();
    fs::create_dir(root.path().join("folder")).unwrap();
    let socket_path = root.path().join("folder/socket");
    let _socket = UnixListener::bind(&socket_path).unwrap();
    assert!(vault.refresh_index().is_ok());
    assert_eq!(vault.list_entries().unwrap().len(), 1);
    assert!(vault.rename("folder", "moved").is_err());
    assert!(socket_path.exists());
    assert!(!root.path().join("moved").exists());
}

#[test]
fn create_file_with_initial_content_is_exclusive_and_directory_rejects_content() {
    let (root, _state, vault) = setup();
    vault
        .create_entry("种子.md", EntryKind::File, "# 计划\n\n".as_bytes())
        .unwrap();
    assert_eq!(vault.read("种子.md").unwrap(), "# 计划\n\n".as_bytes());
    // 同名独占仍然生效，不覆盖已有内容。
    assert!(vault
        .create_entry("种子.md", EntryKind::File, b"other")
        .is_err());
    assert_eq!(vault.read("种子.md").unwrap(), "# 计划\n\n".as_bytes());
    // 目录携带内容在写盘前拒绝。
    assert!(vault
        .create_entry("目录", EntryKind::Directory, b"x")
        .is_err());
    assert!(!root.path().join("目录").exists());
}
