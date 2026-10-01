use noemori_vault::{Error, Vault};
use std::fs;
use tempfile::TempDir;

fn vault_with(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for (name, body) in files {
        fs::write(root.path().join(name), body).expect("写夹具");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

#[test]
fn rename_updates_wiki_and_markdown_links() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "See [[B]] and [go](./B.md)\n"),
        ("B.md", "# B\n"),
        ("code.md", "```\n[[B]]\n```\n"),
    ]);

    vault.rename("B.md", "C.md").expect("改名");

    let a = fs::read_to_string(root.path().join("A.md")).expect("A");
    assert!(a.contains("[[C]]"));
    assert!(a.contains("[go](./C.md)"));
    assert!(!a.contains("[[B]]"));
    assert!(!root.path().join("B.md").exists());
    assert!(root.path().join("C.md").exists());

    let code = fs::read_to_string(root.path().join("code.md")).expect("code");
    assert!(code.contains("[[B]]"));

    let incoming = vault.links_to("C.md").expect("入链");
    assert!(incoming.iter().any(|l| l.from_path == "A.md"));
}

#[test]
fn rename_refuses_stem_that_collides_with_another_notes_title() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[[B]]\n"),
        ("B.md", "# B\n"),
        ("Other.md", "# C\n"),
    ]);
    let before = fs::read(root.path().join("A.md")).expect("A");
    let err = vault.rename("B.md", "C.md").expect_err("标题冲突");
    let message = err.to_string();
    assert!(message.contains("歧义"), "{message}");
    assert_eq!(fs::read(root.path().join("A.md")).expect("A"), before);
    assert!(root.path().join("B.md").exists());
    assert!(!root.path().join("C.md").exists());
}

#[test]
fn rename_refuses_existing_destination_and_leaves_bytes() {
    let (root, _index, vault) =
        vault_with(&[("A.md", "[[B]]\n"), ("B.md", "b\n"), ("C.md", "c\n")]);
    let a_before = fs::read(root.path().join("A.md")).expect("A");
    let b_before = fs::read(root.path().join("B.md")).expect("B");

    let err = vault.rename("B.md", "C.md").expect_err("应失败");
    assert!(matches!(err, Error::AlreadyExists { .. }));
    assert_eq!(fs::read(root.path().join("A.md")).expect("A"), a_before);
    assert_eq!(fs::read(root.path().join("B.md")).expect("B"), b_before);
}

#[test]
fn rename_updates_links_after_multibyte_prefix() {
    let prefix = "字".repeat(200);
    let body = format!("{prefix}[[B]] {prefix}[go](./B.md)\n");
    let (root, _index, vault) = vault_with(&[("A.md", &body), ("B.md", "# B\n")]);

    vault.rename("B.md", "C.md").expect("改名");

    let a = fs::read_to_string(root.path().join("A.md")).expect("A");
    assert!(a.contains("[[C]]"));
    assert!(a.contains("[go](./C.md)"));
    assert!(!a.contains("[[B]]"));
    assert!(!a.contains("./B.md"));
}

#[test]
fn rename_keeps_markdown_and_wiki_fragments() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[go](./B.md#sec) [[B#sec]] [[B#sec|别名]]\n"),
        ("B.md", "# B\n"),
    ]);

    vault.rename("B.md", "C.md").expect("改名");

    let a = fs::read_to_string(root.path().join("A.md")).expect("A");
    assert!(a.contains("[go](./C.md#sec)"));
    assert!(a.contains("[[C#sec]]"));
    assert!(a.contains("[[C#sec|别名]]"));
    assert!(!a.contains("B.md"));
    assert!(!a.contains("[[B"));

    let incoming = vault.links_to("C.md").expect("入链");
    assert_eq!(incoming.len(), 3);
}

#[test]
fn rename_preserves_surrounding_text_and_encoded_wiki_targets() {
    let body = "中文 \\* &amp; [[A&#38;B|别名]] tail\n";
    let (root, _index, vault) = vault_with(&[("src.md", body), ("A&B.md", "note")]);
    vault.rename("A&B.md", "C&D.md").expect("改名");
    let saved = fs::read_to_string(root.path().join("src.md")).expect("读回");
    assert_eq!(saved, "中文 \\* &amp; [[C&#38;D|别名]] tail\n");
    assert_eq!(vault.links_to("C&D.md").expect("入链").len(), 1);
}

#[test]
fn rename_keeps_wiki_alias_separator_escaped_in_tables() {
    let (root, _index, vault) = vault_with(&[
        ("src.md", "| Note |\n| --- |\n| [[B\\|别名]] |\n"),
        ("B.md", "note"),
    ]);
    vault.rename("B.md", "C.md").expect("改名");
    assert_eq!(
        fs::read_to_string(root.path().join("src.md")).expect("读回"),
        "| Note |\n| --- |\n| [[C\\|别名]] |\n"
    );
}

#[test]
fn rename_uses_current_source_instead_of_stale_index_offsets() {
    let (root, _index, vault) = vault_with(&[("A.md", "[[B]]\n"), ("B.md", "note")]);
    fs::write(root.path().join("A.md"), "新增正文 [[B]]\n").unwrap();
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "新增正文 [[C]]\n"
    );
}

#[test]
fn rename_validates_content_even_when_mtime_and_length_match_index() {
    let (root, _index, vault) = vault_with(&[
        ("source.md", "前文 [[Old]]\n"),
        ("target.md", "---\naliases: [Old]\n---\n# Target\n"),
    ]);
    // 外部工具可保留时间戳；正文哈希才足以证明链接区间和别名仍属同一版本。
    for (path, text) in [
        ("source.md", "后文 [[New]]\n"),
        ("target.md", "---\naliases: [New]\n---\n# Target\n"),
    ] {
        let path = root.path().join(path);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, text).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
    vault.rename("target.md", "renamed.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("source.md")).unwrap(),
        "后文 [[renamed]]\n"
    );
    assert_eq!(vault.links_to("renamed.md").unwrap().len(), 1);
}

#[test]
fn consecutive_moves_reuse_only_facts_for_current_bytes_and_paths() {
    let (root, index, vault) = vault_with(&[
        ("a.md", "[next](./b.md)\n"),
        ("b.md", "[next](./c.md)\n"),
        ("c.md", "[[a]]\n"),
    ]);
    fs::create_dir(root.path().join("archive")).unwrap();
    for name in ["a.md", "b.md", "c.md"] {
        let outcome = vault.rename(name, &format!("archive/{name}")).unwrap();
        assert!(outcome.warning.is_none());
    }
    assert_eq!(vault.read("archive/a.md").unwrap(), b"[next](./b.md)\n");
    assert_eq!(vault.read("archive/b.md").unwrap(), b"[next](./c.md)\n");
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    for name in ["a.md", "b.md", "c.md"] {
        assert_eq!(
            reopened.links_to(&format!("archive/{name}")).unwrap().len(),
            1
        );
    }
}

#[test]
fn large_move_validates_live_aliases_and_backlinks_across_snapshot_chunks() {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::create_dir(root.path().join("archive")).unwrap();
    fs::write(root.path().join("target.md"), "---\naliases: [Old]\n---\n").unwrap();
    for number in 0..256 {
        fs::write(
            root.path().join(format!("{number:03}.MD")),
            "前文 [[Old]]\n",
        )
        .unwrap();
    }
    let vault = Vault::open(root.path(), index.path()).unwrap();
    // 分片边界不能改变版本契约：保留时间戳和长度的外部编辑仍必须按新内容处理。
    for (name, text) in (0..256)
        .map(|number| (format!("{number:03}.MD"), "后文 [[New]]\n"))
        .chain([(String::from("target.md"), "---\naliases: [New]\n---\n")])
    {
        let path = root.path().join(name);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, text).unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
    let outcome = vault.rename("target.md", "archive/renamed.md").unwrap();
    assert!(outcome.warning.is_none());
    for number in 0..256 {
        assert_eq!(
            vault.read(&format!("{number:03}.MD")).unwrap(),
            "后文 [[renamed]]\n".as_bytes()
        );
    }
    assert_eq!(vault.links_to("archive/renamed.md").unwrap().len(), 256);
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(reopened.links_to("archive/renamed.md").unwrap().len(), 256);
}

#[cfg(unix)]
#[test]
fn unreadable_snapshot_chunk_prevents_all_writes() {
    use std::os::unix::fs::PermissionsExt;

    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("target.md"), "target\n").unwrap();
    for number in 0..256 {
        fs::write(root.path().join(format!("{number:03}.md")), "[[target]]\n").unwrap();
    }
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let blocked = root.path().join("255.md");
    let permissions = fs::metadata(&blocked).unwrap().permissions();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
    // 提权测试环境可能绕过文件权限，此时不能制造本测试需要的真实读盘错误。
    if fs::read(&blocked).is_ok() {
        fs::set_permissions(blocked, permissions).unwrap();
        eprintln!("当前用户可绕过文件权限，跳过不可读分片场景");
        return;
    }
    let outcome = vault.rename("target.md", "renamed.md");
    fs::set_permissions(blocked, permissions).unwrap();
    assert!(outcome.is_err());
    assert_eq!(vault.read("target.md").unwrap(), b"target\n");
    assert!(!root.path().join("renamed.md").exists());
    for number in 0..256 {
        assert_eq!(
            vault.read(&format!("{number:03}.md")).unwrap(),
            b"[[target]]\n"
        );
    }
    let recovery = rusqlite::Connection::open(index.path().join("recovery.sqlite")).unwrap();
    let pending: i64 = recovery
        .query_row("SELECT count(*) FROM rename_operation", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(pending, 0);
}

#[test]
fn invalid_destination_parent_does_not_leave_rewritten_backlinks() {
    let (root, _index, vault) =
        vault_with(&[("A.md", "[[B]]\n"), ("B.md", "note"), ("blocked", "file")]);
    assert!(vault.rename("B.md", "blocked/C.md").is_err());
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[[B]]\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("B.md")).unwrap(),
        "note"
    );
}

#[test]
fn rename_preserves_markdown_titles_and_balanced_destination_syntax() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[label](<./B.md#sec> \"title ](x)\")\n"),
        ("B.md", "note"),
    ]);
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[label](<./C.md#sec> \"title ](x)\")\n"
    );
}

#[test]
fn moving_a_note_preserves_outgoing_relative_links_and_self_links() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[B](./B.md)\n"),
        ("B.md", "[peer](./A.md#sec) [[B]] [self](./B.md)\n"),
    ]);
    vault.rename("B.md", "nested/C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[B](./nested/C.md)\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("nested/C.md")).unwrap(),
        "[peer](../A.md#sec) [[C]] [self](./C.md)\n"
    );
    assert_eq!(vault.links_to("nested/C.md").unwrap().len(), 3);
    assert_eq!(vault.links_to("A.md").unwrap().len(), 1);
}

#[test]
fn wiki_links_in_markdown_labels_are_rewritten_without_overlapping_edits() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[see [[B]]](./B.md \"title\")\n"),
        ("B.md", "note"),
    ]);
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[see [[C]]](./C.md \"title\")\n"
    );
    assert_eq!(vault.links_to("C.md").unwrap().len(), 2);
}

#[test]
fn renamed_special_characters_are_encoded_and_resolve_back_to_the_actual_filename() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[`]`](./B.md#sec 'keep title')\n"),
        ("B.md", "note"),
    ]);
    vault.rename("B.md", "C (一)&.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[`]`](./C%20%28%E4%B8%80%29%26.md#sec 'keep title')\n"
    );
    assert_eq!(vault.links_to("C (一)&.md").unwrap().len(), 1);
}

#[test]
fn files_added_and_links_removed_since_indexing_use_the_current_disk_state() {
    let (root, _index, vault) = vault_with(&[("A.md", "[[B]]\n"), ("B.md", "note")]);
    fs::write(root.path().join("A.md"), "unrelated content\n").unwrap();
    fs::write(root.path().join("new.md"), "new [[B]]\n").unwrap();
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "unrelated content\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("new.md")).unwrap(),
        "new [[C]]\n"
    );
}

#[test]
fn ambiguous_wiki_target_names_are_rejected_before_any_file_changes() {
    let (root, _index, vault) =
        vault_with(&[("A.md", "[[B]]\n"), ("B.md", "note"), ("C.txt", "other")]);
    assert!(vault
        .rename("B.md", "C.md")
        .unwrap_err()
        .to_string()
        .contains("歧义"));
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[[B]]\n"
    );
    assert!(root.path().join("B.md").exists());
    assert!(!root.path().join("C.md").exists());
}

#[test]
fn reference_links_rewrite_only_the_effective_definition_and_keep_labels() {
    let source = "[guide][REF] [ref][] [ref]\n\n[ref]: <./B.md#sec> \"keep title\"\n[REF]: ./ignored.md\n[unused]: ./B.md\n";
    let (root, _index, vault) = vault_with(&[("A.md", source), ("B.md", "note")]);
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        source.replacen("<./B.md#sec>", "<./C.md#sec>", 1)
    );
    assert_eq!(vault.links_to("C.md").unwrap().len(), 1);
}

#[test]
fn renaming_an_image_updates_inline_and_reference_images() {
    let source =
        "![a [nested] label](./photo.png \"caption\") ![second][image]\n\n[image]: <./photo.png>\n";
    let (root, _index, vault) = vault_with(&[("A.md", source), ("photo.png", "image bytes")]);
    vault.rename("photo.png", "new photo.png").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        source.replace("./photo.png", "./new%20photo.png")
    );
    assert_eq!(vault.links_to("new photo.png").unwrap().len(), 2);
    assert_eq!(
        fs::read(root.path().join("new photo.png")).unwrap(),
        b"image bytes"
    );
}

#[test]
fn moving_a_note_rebases_images_and_reference_definitions() {
    let source = "![photo](./photo.png) [peer][p]\n\n[p]: ./A.md \"title\"\n";
    let (root, _index, vault) = vault_with(&[
        ("A.md", "peer"),
        ("B.md", source),
        ("photo.png", "image bytes"),
    ]);
    vault.rename("B.md", "nested/C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("nested/C.md")).unwrap(),
        "![photo](../photo.png) [peer][p]\n\n[p]: ../A.md \"title\"\n"
    );
    assert_eq!(vault.links_from("nested/C.md").unwrap().len(), 2);
}

#[test]
fn rename_rewrites_path_form_wiki_links_keeping_their_shape() {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    fs::create_dir_all(root.path().join("notes")).expect("建目录");
    fs::write(root.path().join("notes/foo.md"), "# foo\n").expect("写目标");
    fs::write(
        root.path().join("ref.md"),
        "[[notes/foo]] [[notes/foo.md|别名]] [[notes/foo#sec]] [[foo]]\n",
    )
    .expect("写引用");
    let vault = Vault::open(root.path(), index.path()).expect("打开");

    vault.rename("notes/foo.md", "notes/bar.md").expect("改名");

    let reference = fs::read_to_string(root.path().join("ref.md")).expect("读引用");
    assert!(reference.contains("[[notes/bar]]"), "{reference}");
    assert!(reference.contains("[[notes/bar.md|别名]]"), "{reference}");
    assert!(reference.contains("[[notes/bar#sec]]"), "{reference}");
    // 名称形式保持名称形式。
    assert!(reference.contains("[[bar]]"), "{reference}");
    assert!(!reference.contains("foo"), "{reference}");
    assert_eq!(vault.links_to("notes/bar.md").expect("入链").len(), 4);
}

#[test]
fn directory_rename_updates_path_form_wiki_links() {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    fs::create_dir_all(root.path().join("dir")).expect("建目录");
    fs::write(root.path().join("dir/note.md"), "# note\n").expect("写目标");
    fs::write(
        root.path().join("ref.md"),
        "[[dir/note]] [x](./dir/note.md)\n",
    )
    .expect("写引用");
    let vault = Vault::open(root.path(), index.path()).expect("打开");

    vault.rename("dir", "archive").expect("目录改名");

    let reference = fs::read_to_string(root.path().join("ref.md")).expect("读引用");
    assert!(reference.contains("[[archive/note]]"), "{reference}");
    assert!(reference.contains("[x](./archive/note.md)"), "{reference}");
    assert_eq!(vault.links_to("archive/note.md").expect("入链").len(), 2);
}

#[test]
fn path_form_links_are_not_blocked_by_bare_name_ambiguity() {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for dir in ["a", "b"] {
        fs::create_dir_all(root.path().join(dir)).expect("建目录");
    }
    fs::write(root.path().join("a/foo.md"), "# foo\n").expect("写 a/foo");
    fs::write(root.path().join("b/bar.md"), "# bar\n").expect("写 b/bar");
    fs::write(root.path().join("ref.md"), "[[a/foo]]\n").expect("写引用");
    let vault = Vault::open(root.path(), index.path()).expect("打开");

    // 改名后裸名 bar 会歧义，但引用是路径形式，重写后仍唯一解析，不应拒绝。
    vault
        .rename("a/foo.md", "a/bar.md")
        .expect("路径形式不受名称歧义阻挡");

    let reference = fs::read_to_string(root.path().join("ref.md")).expect("读引用");
    assert!(reference.contains("[[a/bar]]"), "{reference}");
    assert_eq!(vault.links_to("a/bar.md").expect("入链").len(), 1);
}
