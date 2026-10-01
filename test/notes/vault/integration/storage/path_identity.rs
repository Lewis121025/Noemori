#![cfg(unix)]

use noemori_vault::{LinkKind, LinkTarget, Vault, WriteOutcome};
use std::fs;
use tempfile::TempDir;

fn fixture() -> (TempDir, TempDir) {
    (TempDir::new().unwrap(), TempDir::new().unwrap())
}

#[test]
fn literal_backslash_and_directory_separator_have_distinct_inventory_and_links() {
    let (root, state) = fixture();
    fs::create_dir(root.path().join("group")).unwrap();
    fs::write(root.path().join("group\\note.md"), "literal").unwrap();
    fs::write(root.path().join("group/note.md"), "nested").unwrap();
    fs::write(
        root.path().join("ref.md"),
        "[literal](./group%5Cnote.md) [nested](./group/note.md)\n",
    )
    .unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    assert_eq!(
        vault.list_files().unwrap(),
        ["group/note.md", "group\\note.md", "ref.md"]
    );
    for (raw, target) in [
        ("./group%5Cnote.md", "group\\note.md"),
        ("./group/note.md", "group/note.md"),
    ] {
        assert_eq!(
            vault.resolve_link("ref.md", raw, LinkKind::Markdown),
            LinkTarget::Resolved {
                path: target.to_string(),
                anchor: None,
            }
        );
        assert_eq!(vault.links_to(target).unwrap().len(), 1);
    }
    assert!(matches!(
        vault
            .write("group\\note.md", b"edited", Some(b"literal"))
            .unwrap(),
        WriteOutcome::Saved { warning: None }
    ));
    assert_eq!(vault.read("group\\note.md").unwrap(), b"edited");
    assert_eq!(vault.read("group/note.md").unwrap(), b"nested");
}

#[test]
fn copy_returns_the_literal_filename_that_was_committed() {
    let (root, state) = fixture();
    fs::write(root.path().join("note\\draft.md"), b"original").unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    let copy = vault
        .write_copy("note\\draft.md", b"copy", Some(b"original"))
        .unwrap();
    assert_eq!(copy.path, "note\\draft (副本).md");
    assert!(copy.warning.is_none());
    assert_eq!(vault.read(&copy.path).unwrap(), b"copy");
    assert_eq!(vault.read("note\\draft.md").unwrap(), b"original");
    assert!(!root.path().join("note").exists());
}

#[test]
fn rename_does_not_select_the_similarly_spelled_file_in_a_directory() {
    let (root, state) = fixture();
    fs::create_dir(root.path().join("group")).unwrap();
    fs::write(root.path().join("group\\note.md"), b"literal").unwrap();
    fs::write(root.path().join("group/note.md"), b"nested").unwrap();
    fs::write(
        root.path().join("ref.md"),
        "[literal](./group%5Cnote.md) [nested](./group/note.md)\n",
    )
    .unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    assert!(vault
        .rename("group\\note.md", "renamed.md")
        .unwrap()
        .warning
        .is_none());
    assert_eq!(vault.read("renamed.md").unwrap(), b"literal");
    assert_eq!(vault.read("group/note.md").unwrap(), b"nested");
    assert!(!root.path().join("group\\note.md").exists());
    assert_eq!(
        vault.read("ref.md").unwrap(),
        b"[literal](./renamed.md) [nested](./group/note.md)\n"
    );
}

#[test]
fn folder_move_preserves_literal_names_and_encodes_backslashes_in_links() {
    let (root, state) = fixture();
    fs::create_dir_all(root.path().join("old/empty\\folder")).unwrap();
    fs::write(root.path().join("old/note\\draft.md"), b"content").unwrap();
    fs::write(
        root.path().join("ref.md"),
        "[draft](./old/note%5Cdraft.md#section)\n",
    )
    .unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    assert!(vault.rename("old", "new").unwrap().warning.is_none());
    assert!(root.path().join("new/empty\\folder").is_dir());
    assert!(!root.path().join("new/empty").exists());
    assert_eq!(vault.read("new/note\\draft.md").unwrap(), b"content");
    assert_eq!(
        vault.read("ref.md").unwrap(),
        b"[draft](./new/note%5Cdraft.md#section)\n"
    );
    assert_eq!(vault.links_to("new/note\\draft.md").unwrap().len(), 1);
}

#[test]
fn attachments_stay_beside_notes_in_directories_with_literal_backslashes() {
    let (root, state) = fixture();
    fs::create_dir(root.path().join("资料\\原稿")).unwrap();
    fs::write(root.path().join("资料\\原稿/笔记.md"), b"note").unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    let attachment = vault
        .import_attachment("资料\\原稿/笔记.md", "图.png", &[0, 255, 13, 10])
        .unwrap();
    assert_eq!(attachment.path, "资料\\原稿/attachments/图.png");
    assert!(attachment.warning.is_none());
    assert_eq!(vault.read(&attachment.path).unwrap(), [0, 255, 13, 10]);
    assert_eq!(
        vault.resolve_link(
            "资料\\原稿/笔记.md",
            "./attachments/%E5%9B%BE.png",
            LinkKind::Markdown,
        ),
        LinkTarget::Resolved {
            path: attachment.path.clone(),
            anchor: None,
        }
    );
    assert!(!root.path().join("资料").exists());
}

#[test]
fn previous_index_paths_are_rebuilt_without_removing_recovery_drafts() {
    let (root, state) = fixture();
    fs::create_dir(root.path().join("group")).unwrap();
    fs::write(root.path().join("group/note.md"), b"nested").unwrap();
    fs::write(
        root.path().join("ref.md"),
        b"[missing](./group%5Cnote.md)\n",
    )
    .unwrap();
    let vault = Vault::open(root.path(), state.path()).unwrap();
    vault
        .write("group/note.md", b"recoverable", Some(b"old"))
        .unwrap();
    drop(vault);
    let database = rusqlite::Connection::open(state.path().join("index.sqlite")).unwrap();
    database
        .execute("UPDATE links SET to_path = 'group/note.md'", [])
        .unwrap();
    database.pragma_update(None, "user_version", 5).unwrap();
    drop(database);
    let reopened = Vault::open(root.path(), state.path()).unwrap();
    assert!(reopened.links_to("group/note.md").unwrap().is_empty());
    assert_eq!(
        reopened
            .snapshot("group/note.md")
            .unwrap()
            .draft
            .unwrap()
            .bytes,
        b"recoverable"
    );
    assert_eq!(reopened.read("group/note.md").unwrap(), b"nested");
}

#[test]
fn path_text_rejects_non_utf8_instead_of_replacing_filename_bytes() {
    use std::os::unix::ffi::OsStrExt;
    let invalid = std::path::Path::new(std::ffi::OsStr::from_bytes(b"note\xff.md"));
    let error = noemori_vault::path_to_slashes(invalid).unwrap_err();
    assert!(error.to_string().contains("UTF-8"), "{error}");
}

#[test]
#[cfg(target_os = "linux")]
fn non_utf8_names_cannot_alias_a_real_replacement_character_filename() {
    use std::os::unix::ffi::OsStrExt;
    let (root, state) = fixture();
    let invalid = std::ffi::OsStr::from_bytes(b"note\xff.md");
    fs::write(root.path().join(invalid), b"invalid name").unwrap();
    fs::write(root.path().join("note\u{fffd}.md"), b"valid name").unwrap();
    let error = match Vault::open(root.path(), state.path()) {
        Ok(_) => panic!("无损表示失败时必须拒绝目录快照"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("UTF-8"), "{error}");
    assert_eq!(
        fs::read(root.path().join(invalid)).unwrap(),
        b"invalid name"
    );
    assert_eq!(
        fs::read(root.path().join("note\u{fffd}.md")).unwrap(),
        b"valid name"
    );
}
