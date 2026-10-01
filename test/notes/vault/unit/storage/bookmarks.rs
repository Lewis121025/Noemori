//! 书签：库内 `.noemori/bookmarks.json` 的读写、损坏回退与改名同步。

use noemori_vault::{Bookmark, Error, Vault};
use std::fs;
use tempfile::TempDir;

fn vault_with(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for (path, content) in files {
        let full = root.path().join(path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).expect("目录");
        }
        fs::write(full, content).expect("写入");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn sample() -> Vec<Bookmark> {
    vec![
        Bookmark::File {
            path: "notes/a.md".to_string(),
            title: None,
        },
        Bookmark::Folder {
            path: "notes".to_string(),
            title: Some("笔记夹".to_string()),
        },
        Bookmark::Heading {
            path: "notes/a.md".to_string(),
            heading: "小节".to_string(),
            title: None,
        },
        Bookmark::Search {
            query: "tag:todo -done".to_string(),
            title: Some("待办".to_string()),
        },
    ]
}

#[test]
fn missing_file_reads_as_empty_and_round_trips() {
    let (root, _index, vault) = vault_with(&[("notes/a.md", "# A\n")]);
    assert!(vault.bookmarks().expect("读取").is_empty());
    vault.set_bookmarks(&sample()).expect("写入");
    assert_eq!(vault.bookmarks().expect("读取"), sample());
    // 书签目录是点目录：不出现在文件树与文件列表里。
    assert!(root.path().join(".noemori/bookmarks.json").is_file());
    let entries = vault.list_entries().expect("目录");
    assert!(entries.iter().all(|entry| !entry.path.starts_with(".noemori")));
}

#[test]
fn corrupt_file_is_an_error_and_is_backed_up_before_overwrite() {
    let (root, _index, vault) = vault_with(&[]);
    fs::create_dir_all(root.path().join(".noemori")).expect("目录");
    fs::write(root.path().join(".noemori/bookmarks.json"), "{不是 JSON").expect("写入");
    assert!(matches!(
        vault.bookmarks(),
        Err(Error::InvalidBookmarks { .. })
    ));
    vault.set_bookmarks(&sample()).expect("覆盖");
    assert_eq!(
        fs::read_to_string(root.path().join(".noemori/bookmarks.corrupt.json")).expect("备份"),
        "{不是 JSON"
    );
    assert_eq!(vault.bookmarks().expect("读取"), sample());
}

#[test]
fn invalid_paths_are_rejected() {
    let (_root, _index, vault) = vault_with(&[]);
    for path in ["../escape.md", "", "/abs.md"] {
        let result = vault.set_bookmarks(&[Bookmark::File {
            path: path.to_string(),
            title: None,
        }]);
        assert!(result.is_err(), "应拒绝路径 {path:?}");
    }
}

#[test]
fn rename_remaps_bookmarked_paths_without_warning() {
    let (_root, _index, vault) = vault_with(&[("notes/a.md", "# A\n"), ("other.md", "# O\n")]);
    vault.set_bookmarks(&sample()).expect("写入");
    let outcome = vault.rename("notes", "archive").expect("改名");
    assert_eq!(outcome.warning, None);
    let mut expected = sample();
    for bookmark in &mut expected {
        match bookmark {
            Bookmark::File { path, .. }
            | Bookmark::Folder { path, .. }
            | Bookmark::Heading { path, .. } => {
                *path = path.replacen("notes", "archive", 1);
            }
            Bookmark::Search { .. } => {}
        }
    }
    assert_eq!(vault.bookmarks().expect("读取"), expected);
    // 没有书签文件时改名不创建它。
    let (root, _index, plain) = vault_with(&[("x.md", "x\n")]);
    plain.rename("x.md", "y.md").expect("改名");
    assert!(!root.path().join(".noemori").exists());
}
