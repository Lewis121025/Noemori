//! 链接解析：路径形式消歧、锚点分离与歧义候选。

use noemori_vault::{LinkKind, LinkResolution, LinkTarget, Vault};
use std::fs;
use tempfile::TempDir;

fn vault_with(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for (name, body) in files {
        let path = root.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("建目录");
        }
        fs::write(path, body).expect("写夹具");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn resolve(vault: &Vault, from: &str, raw: &str, kind: LinkKind) -> LinkTarget {
    vault.resolve_link(from, raw, kind)
}

#[test]
fn wiki_path_form_resolves_with_or_without_extension() {
    let (_root, _index, vault) = vault_with(&[("notes/foo.md", "# foo\n"), ("ref.md", "x\n")]);
    for raw in ["notes/foo", "notes/foo.md"] {
        assert_eq!(
            resolve(&vault, "ref.md", raw, LinkKind::Wiki),
            LinkTarget::Resolved {
                path: "notes/foo.md".to_string(),
                anchor: None,
            },
            "{raw} 应唯一解析"
        );
    }
}

#[test]
fn bare_name_ambiguity_returns_sorted_candidates_and_path_form_disambiguates() {
    let (_root, _index, vault) = vault_with(&[
        ("a/foo.md", "# a\n"),
        ("b/foo.md", "# b\n"),
        ("ref.md", "x\n"),
    ]);
    assert_eq!(
        resolve(&vault, "ref.md", "foo", LinkKind::Wiki),
        LinkTarget::Ambiguous {
            candidates: vec!["a/foo.md".to_string(), "b/foo.md".to_string()],
            anchor: None,
        }
    );
    // 锚点在歧义时同样带出，选择候选后继续生效。
    assert_eq!(
        resolve(&vault, "ref.md", "foo#sec", LinkKind::Wiki),
        LinkTarget::Ambiguous {
            candidates: vec!["a/foo.md".to_string(), "b/foo.md".to_string()],
            anchor: Some("sec".to_string()),
        }
    );
    assert_eq!(
        resolve(&vault, "ref.md", "a/foo", LinkKind::Wiki),
        LinkTarget::Resolved {
            path: "a/foo.md".to_string(),
            anchor: None,
        }
    );
    // 没有写出的链接不会进索引。
    let indexed = vault.links_from("ref.md").expect("出链");
    assert!(indexed.is_empty(), "ref.md 没有写出链接，仅交互解析");
}

#[test]
fn ambiguous_wiki_links_stay_unresolved_in_the_index() {
    let (_root, _index, vault) = vault_with(&[
        ("a/foo.md", "note\n"),
        ("b/foo.md", "note\n"),
        ("ref.md", "[[foo]] [[a/foo]]\n"),
    ]);
    let links = vault.links_from("ref.md").expect("出链");
    assert_eq!(links.len(), 2);
    let bare = links
        .iter()
        .find(|link| link.to_raw == "foo")
        .expect("裸名");
    assert_eq!(bare.to_path, None);
    assert_eq!(bare.resolution, LinkResolution::Ambiguous);
    let path_form = links
        .iter()
        .find(|link| link.to_raw == "a/foo")
        .expect("路径");
    assert_eq!(path_form.to_path.as_deref(), Some("a/foo.md"));
    assert_eq!(path_form.resolution, LinkResolution::Resolved);
}

#[test]
fn anchors_are_returned_separately_for_wiki_and_markdown_links() {
    let (_root, _index, vault) = vault_with(&[("t.md", "# t\n"), ("src.md", "x\n")]);
    assert_eq!(
        resolve(&vault, "src.md", "t#sec", LinkKind::Wiki),
        LinkTarget::Resolved {
            path: "t.md".to_string(),
            anchor: Some("sec".to_string()),
        }
    );
    // Markdown 锚点按 URL 规则百分号解码。
    assert_eq!(
        resolve(&vault, "src.md", "./t.md#my%20heading", LinkKind::Markdown),
        LinkTarget::Resolved {
            path: "t.md".to_string(),
            anchor: Some("my heading".to_string()),
        }
    );
    // 查询串后面的片段仍然是锚点。
    assert_eq!(
        resolve(&vault, "src.md", "t?x=1#sec", LinkKind::Wiki),
        LinkTarget::Resolved {
            path: "t.md".to_string(),
            anchor: Some("sec".to_string()),
        }
    );
    // 空片段与空锚点视为无锚点。
    assert_eq!(
        resolve(&vault, "src.md", "t#", LinkKind::Wiki),
        LinkTarget::Resolved {
            path: "t.md".to_string(),
            anchor: None,
        }
    );
}

#[test]
fn pure_anchor_links_resolve_to_the_source_file_without_index_edges() {
    let (_root, _index, vault) = vault_with(&[("src.md", "[[#小节]]\n")]);
    assert_eq!(
        resolve(&vault, "src.md", "#小节", LinkKind::Wiki),
        LinkTarget::Resolved {
            path: "src.md".to_string(),
            anchor: Some("小节".to_string()),
        }
    );
    assert_eq!(
        resolve(&vault, "src.md", "#", LinkKind::Wiki),
        LinkTarget::Dead
    );
    // 自锚点不构成图边：反链里看不到自己。
    assert!(vault.links_to("src.md").expect("入链").is_empty());
    let links = vault.links_from("src.md").expect("出链");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].to_path, None);
    assert_eq!(links[0].resolution, LinkResolution::SelfAnchor);
}

#[test]
fn missing_targets_stay_dead_with_or_without_anchor() {
    let (_root, _index, vault) = vault_with(&[("src.md", "x\n")]);
    assert_eq!(
        resolve(&vault, "src.md", "missing", LinkKind::Wiki),
        LinkTarget::Dead
    );
    assert_eq!(
        resolve(&vault, "src.md", "missing#sec", LinkKind::Wiki),
        LinkTarget::Dead
    );
    assert_eq!(
        resolve(&vault, "src.md", "./missing.md#sec", LinkKind::Markdown),
        LinkTarget::Dead
    );
}

#[test]
fn root_files_keep_resolving_by_name_and_stem() {
    let (_root, _index, vault) = vault_with(&[("foo.md", "# foo\n"), ("ref.md", "[[foo]]\n")]);
    // 根级文件的完整路径键与文件名键重合，去重后仍是唯一命中。
    for raw in ["foo", "foo.md"] {
        assert_eq!(
            resolve(&vault, "ref.md", raw, LinkKind::Wiki),
            LinkTarget::Resolved {
                path: "foo.md".to_string(),
                anchor: None,
            },
            "{raw} 应唯一解析"
        );
    }
    // 名称唯一时保持历史行为：入图。
    let links = vault.links_from("ref.md").expect("出链");
    assert_eq!(links[0].to_path.as_deref(), Some("foo.md"));
    assert_eq!(links[0].resolution, LinkResolution::Resolved);
}

#[test]
fn heading_and_frontmatter_alias_resolve_like_filenames() {
    let (_root, _index, vault) = vault_with(&[
        (
            "notes/a.md",
            "---\naliases:\n  - 甲\nalias: beta\n---\n# 标题甲\n",
        ),
        ("ref.md", "[[标题甲]] [[甲]] [[beta]]\n"),
    ]);
    for raw in ["标题甲", "甲", "beta"] {
        assert_eq!(
            resolve(&vault, "ref.md", raw, LinkKind::Wiki),
            LinkTarget::Resolved {
                path: "notes/a.md".to_string(),
                anchor: None,
            },
            "{raw} 应指向文首标题或别名"
        );
    }
    let links = vault.links_from("ref.md").expect("出链");
    assert!(links.iter().all(|link| {
        link.to_path.as_deref() == Some("notes/a.md") && link.resolution == LinkResolution::Resolved
    }));
}

#[test]
fn duplicate_titles_stay_ambiguous_while_missing_targets_stay_dead() {
    let (_root, _index, vault) = vault_with(&[
        ("a.md", "# 同名\n"),
        ("b.md", "# 同名\n"),
        ("ref.md", "[[同名]] [[没有]]\n"),
    ]);
    assert_eq!(
        resolve(&vault, "ref.md", "同名", LinkKind::Wiki),
        LinkTarget::Ambiguous {
            candidates: vec!["a.md".to_string(), "b.md".to_string()],
            anchor: None,
        }
    );
    let links = vault.links_from("ref.md").expect("出链");
    let same = links
        .iter()
        .find(|link| link.to_raw == "同名")
        .expect("同名");
    assert_eq!(same.to_path, None);
    assert_eq!(same.resolution, LinkResolution::Ambiguous);
    let missing = links
        .iter()
        .find(|link| link.to_raw == "没有")
        .expect("没有");
    assert_eq!(missing.to_path, None);
    assert_eq!(missing.resolution, LinkResolution::Dead);
}

#[test]
fn heading_edit_rebinds_title_links_without_changing_the_file_set() {
    let (root, _index, vault) = vault_with(&[
        ("a.md", "# 旧标题\n"),
        ("ref.md", "[[旧标题]] [[新标题]]\n"),
    ]);
    let before = vault.links_from("ref.md").expect("改前");
    assert_eq!(
        before
            .iter()
            .find(|link| link.to_raw == "旧标题")
            .expect("旧")
            .to_path
            .as_deref(),
        Some("a.md")
    );
    assert_eq!(
        before
            .iter()
            .find(|link| link.to_raw == "新标题")
            .expect("新")
            .resolution,
        LinkResolution::Dead
    );

    let body = fs::read(root.path().join("a.md")).expect("读");
    vault
        .write("a.md", "# 新标题\n".as_bytes(), Some(&body))
        .expect("改标题");

    let after = vault.links_from("ref.md").expect("改后");
    assert_eq!(
        after
            .iter()
            .find(|link| link.to_raw == "旧标题")
            .expect("旧")
            .resolution,
        LinkResolution::Dead
    );
    assert_eq!(
        after
            .iter()
            .find(|link| link.to_raw == "新标题")
            .expect("新")
            .to_path
            .as_deref(),
        Some("a.md")
    );
}
