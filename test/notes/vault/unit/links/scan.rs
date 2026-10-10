use noemori_vault::{LinkKind, LinkResolution, Vault};
use std::fs;
use std::path::Path;
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

fn copy_fixture_dir() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    let fixtures =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../test/notes/vault/fixtures/links");
    for entry in fs::read_dir(&fixtures).expect("夹具目录") {
        let entry = entry.expect("夹具项");
        if entry.file_type().expect("类型").is_file() {
            fs::copy(entry.path(), root.path().join(entry.file_name())).expect("复制夹具");
        }
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn source_slice(root: &Path, rel: &str, start: i64, end: i64) -> String {
    let bytes = fs::read(root.join(rel)).expect("读源");
    let start = usize::try_from(start).expect("start");
    let end = usize::try_from(end).expect("end");
    String::from_utf8(bytes[start..end].to_vec()).expect("utf8")
}

#[test]
fn fenced_and_inline_code_wiki_are_not_indexed() {
    let (_root, _index, vault) = copy_fixture_dir();
    let from = vault.links_from("code_and_wiki.md").expect("出链");
    let raws: Vec<&str> = from.iter().map(|l| l.to_raw.as_str()).collect();
    assert!(!raws.iter().any(|r| r.contains("FakeFence")));
    assert!(!raws.iter().any(|r| r.contains("FakeInline")));
    assert!(raws.contains(&"Other"));
}

#[test]
fn wiki_and_markdown_links_record_byte_ranges() {
    let (root, _index, vault) = copy_fixture_dir();
    let from = vault.links_from("source.md").expect("出链");
    assert_eq!(from.len(), 2);

    let wiki = from
        .iter()
        .find(|l| l.kind == LinkKind::Wiki)
        .expect("wiki");
    assert_eq!(wiki.to_raw, "Other");
    assert_eq!(wiki.to_path.as_deref(), Some("Other.md"));
    assert_eq!(
        source_slice(root.path(), "source.md", wiki.start_byte, wiki.end_byte),
        "[[Other]]"
    );

    let md = from
        .iter()
        .find(|l| l.kind == LinkKind::Markdown)
        .expect("md");
    assert_eq!(md.to_raw, "./Other.md");
    assert_eq!(md.to_path.as_deref(), Some("Other.md"));
    assert_eq!(
        source_slice(root.path(), "source.md", md.start_byte, md.end_byte),
        "[label](./Other.md)"
    );
}

#[test]
fn links_to_other_includes_source() {
    let (_root, _index, vault) = copy_fixture_dir();
    let incoming = vault.links_to("Other.md").expect("入链");
    let sources: Vec<&str> = incoming.iter().map(|l| l.from_path.as_str()).collect();
    assert!(sources.contains(&"source.md"));
    assert!(sources.contains(&"code_and_wiki.md"));
}

#[test]
fn markdown_internal_anchors_are_indexed_without_incoming_edges() {
    let body = "# 本节\n\n[跳转](#本节) [网站](https://example.com/#本节)\n";
    let (root, _index, vault) = vault_with(&[("src.md", body)]);
    let links = vault.links_from("src.md").expect("内部跳转");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].kind, LinkKind::Markdown);
    assert_eq!(links[0].to_raw, "#本节");
    assert_eq!(links[0].resolution, LinkResolution::SelfAnchor);
    assert_eq!(links[0].to_path, None);
    assert_eq!(
        source_slice(
            root.path(),
            "src.md",
            links[0].start_byte,
            links[0].end_byte
        ),
        "[跳转](#本节)"
    );
    assert!(vault.links_to("src.md").expect("入链").is_empty());
}

#[test]
fn previous_scan_version_rebuilds_internal_anchors_without_file_edits() {
    let (root, index, vault) = vault_with(&[("src.md", "# 本节\n\n[跳转](#本节)\n")]);
    drop(vault);
    let conn = rusqlite::Connection::open(index.path().join("index.sqlite")).expect("旧索引");
    conn.execute("DELETE FROM links", [])
        .expect("模拟旧扫描遗漏");
    conn.pragma_update(None, "user_version", 13)
        .expect("旧版本");
    drop(conn);
    let reopened = Vault::open(root.path(), index.path()).expect("重新打开旧库");
    let links = reopened.links_from("src.md").expect("内部跳转");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].resolution, LinkResolution::SelfAnchor);
    assert_eq!(links[0].to_raw, "#本节");
}

#[test]
fn multibyte_prefix_does_not_collapse_markdown_link_ranges() {
    let prefix = "字".repeat(200);
    let body = format!("{prefix}[a](./t.md) {prefix}[b](./t.md)\n");
    let (root, _index, vault) = vault_with(&[("t.md", "# t\n"), ("src.md", &body)]);
    let from = vault.links_from("src.md").expect("出链");
    assert_eq!(from.len(), 2);
    assert_ne!(from[0].start_byte, from[1].start_byte);
    assert_eq!(
        source_slice(root.path(), "src.md", from[0].start_byte, from[0].end_byte),
        "[a](./t.md)"
    );
    assert_eq!(
        source_slice(root.path(), "src.md", from[1].start_byte, from[1].end_byte),
        "[b](./t.md)"
    );
}

#[test]
fn multibyte_prefix_does_not_collapse_wiki_link_ranges() {
    let prefix = "字".repeat(200);
    let body = format!("{prefix}[[t]] {prefix}[[t]]\n");
    let (root, _index, vault) = vault_with(&[("t.md", "# t\n"), ("src.md", &body)]);
    let from = vault.links_from("src.md").expect("出链");
    assert_eq!(from.len(), 2);
    assert!(from.iter().all(|link| link.kind == LinkKind::Wiki));
    assert_ne!(from[0].start_byte, from[1].start_byte);
    assert_eq!(
        source_slice(root.path(), "src.md", from[0].start_byte, from[0].end_byte),
        "[[t]]"
    );
    assert_eq!(
        source_slice(root.path(), "src.md", from[1].start_byte, from[1].end_byte),
        "[[t]]"
    );
}

#[test]
fn markdown_and_wiki_fragments_resolve_to_note() {
    let (_root, _index, vault) = vault_with(&[
        ("t.md", "# t\n"),
        (
            "src.md",
            "[md](./t.md#sec) [q](./t.md?x=1) [[t#sec]] [[t#sec|别名]]\n",
        ),
    ]);
    let from = vault.links_from("src.md").expect("出链");
    assert_eq!(from.len(), 4);
    assert!(from
        .iter()
        .all(|link| link.to_path.as_deref() == Some("t.md")));

    let incoming = vault.links_to("t.md").expect("入链");
    assert_eq!(incoming.len(), 4);
}

#[test]
fn wiki_ranges_use_original_bytes_before_entity_decoding() {
    let body = "中文 \\* &amp; [[A&#38;B|别名]] tail\n";
    let (root, _index, vault) = vault_with(&[("A&B.md", "note"), ("src.md", body)]);
    let links = vault.links_from("src.md").expect("出链");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].to_path.as_deref(), Some("A&B.md"));
    assert_eq!(
        source_slice(
            root.path(),
            "src.md",
            links[0].start_byte,
            links[0].end_byte
        ),
        "[[A&#38;B|别名]]"
    );
}

#[test]
fn wiki_scan_agrees_with_editor_syntax_boundaries() {
    let body = "---\nexample: '[[Other]]'\n---\n\n\\[[Other]] &#91;&#91;Other&#93;&#93; $[[Other]]$\n\n$$\n[[Other]]\n$$\n\n[x](<./[[Other]].md>)\n\n[[Other]]\n\n[Other]: ./elsewhere.md\n";
    let (_root, _index, vault) = vault_with(&[("Other.md", "note"), ("src.md", body)]);
    let links = vault.links_from("src.md").expect("出链");
    let wiki: Vec<_> = links
        .iter()
        .filter(|link| link.kind == LinkKind::Wiki)
        .collect();
    assert_eq!(wiki.len(), 1);
    assert_eq!(wiki[0].to_path.as_deref(), Some("Other.md"));
}

#[test]
fn inline_data_and_external_image_urls_are_not_reported_as_local_dead_links() {
    let body = "![data](data:image/png;base64,AAAA) ![remote](//example.com/a.png) [call](tel:123) ![local](./photo.png)\n";
    let (_root, _index, vault) = vault_with(&[("photo.png", "image bytes"), ("src.md", body)]);
    let links = vault.links_from("src.md").unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].to_path.as_deref(), Some("photo.png"));
}
