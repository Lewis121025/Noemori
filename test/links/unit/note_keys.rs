//! 笔记身份键清单：快速切换器与别名补全按标题与别名匹配笔记。

use nous_vault::{NoteKeys, Vault};
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

#[test]
fn lists_markdown_titles_and_both_alias_forms() {
    let (_root, _index, vault) = vault_with(&[
        ("a.md", "---\naliases: [甲, Alpha]\n---\n# 标题甲\n"),
        ("dir/b.md", "---\nalias: 乙, Beta\n---\n正文\n"),
        ("image.png", "not markdown"),
    ]);
    let keys = vault.note_keys().expect("身份键");
    assert_eq!(
        keys,
        vec![
            NoteKeys {
                path: "a.md".to_string(),
                title: "标题甲".to_string(),
                aliases: vec!["甲".to_string(), "Alpha".to_string()],
            },
            NoteKeys {
                path: "dir/b.md".to_string(),
                title: "b".to_string(),
                aliases: vec!["乙".to_string(), "Beta".to_string()],
            },
        ],
    );
}

#[test]
fn follows_title_edits_after_write() {
    let (root, _index, vault) = vault_with(&[("note.md", "# 旧标题\n")]);
    let before = fs::read(root.path().join("note.md")).expect("读取");
    vault
        .write("note.md", "# 新标题\n".as_bytes(), Some(&before))
        .expect("保存");
    let keys = vault.note_keys().expect("身份键");
    assert_eq!(keys[0].title, "新标题");
    assert!(keys[0].aliases.is_empty());
}
