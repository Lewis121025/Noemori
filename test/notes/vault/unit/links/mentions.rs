use noemori_vault::{MentionKind, Vault};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn vault_with(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for (name, body) in files {
        let path = root.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("目录");
        }
        fs::write(path, body).expect("写夹具");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

#[test]
fn linked_mentions_use_surrounding_paragraph_as_snippet() {
    let (_root, _index, vault) = vault_with(&[
        ("Topic.md", "# Topic\n"),
        (
            "Src.md",
            "intro line\n\nThis para has [[Topic]] inside.\n\nafter line\n",
        ),
    ]);
    let mentions = vault.mentions_to("Topic.md").expect("提及");
    assert_eq!(mentions.linked.len(), 1);
    let linked = &mentions.linked[0];
    assert_eq!(linked.from_path, "Src.md");
    assert_eq!(linked.from_title, "Src");
    assert_eq!(linked.kind, MentionKind::Linked);
    assert!(
        linked.snippet.contains("This para has [[Topic]] inside."),
        "snippet = {:?}",
        linked.snippet
    );
    assert!(
        !linked.snippet.contains("intro line"),
        "snippet leaked previous paragraph: {:?}",
        linked.snippet
    );
    assert!(
        !linked.snippet.contains("after line"),
        "snippet leaked next paragraph: {:?}",
        linked.snippet
    );
}

#[test]
fn unlinked_ranges_follow_source_bytes_after_markdown_normalization() {
    for body in [
        "> 第一行\n> 中文阅读内容\n",
        "> 第一行\r\n> 中文阅读内容\r\n",
        "&amp; 中文阅读内容\n",
        "\\* 中文阅读内容\n",
    ] {
        let (_root, _index, vault) = vault_with(&[("阅读.md", "# 阅读\n"), ("资料.md", body)]);
        let mentions = vault.mentions_to("阅读.md").expect("提及不应崩溃");
        assert_eq!(mentions.unlinked.len(), 1, "{body:?}");
        let hit = &mentions.unlinked[0];
        let start = usize::try_from(hit.start_byte).expect("起点");
        let end = usize::try_from(hit.end_byte).expect("终点");
        assert_eq!(body.get(start..end), Some("阅读"), "{body:?}");
        assert_eq!(hit.to_raw, "阅读");
        assert!(hit.snippet.contains("中文阅读内容"));
    }
}

#[test]
fn unlinked_does_not_treat_character_reference_syntax_as_visible_text() {
    let body = "&amp; 后面才是 amp。\n";
    let (_root, _index, vault) = vault_with(&[("amp.md", "# amp\n"), ("资料.md", body)]);
    let mentions = vault.mentions_to("amp.md").expect("提及");
    assert_eq!(mentions.unlinked.len(), 1);
    assert_eq!(
        mentions.unlinked[0].start_byte,
        i64::try_from(body.rfind("amp").expect("正文命中")).expect("字节位置")
    );
}

#[test]
fn linked_snippets_tolerate_stale_offsets_inside_utf8_characters() {
    let (root, _index, vault) = vault_with(&[
        ("Topic.md", "# Topic\n"),
        ("资料.md", "word [[Topic]] tail\n"),
    ]);
    // 外部改写到监视刷新之间，索引里的字节位置仍属于旧文本。
    fs::write(
        root.path().join("资料.md"),
        "中文段落已经由外部工具改写。\n",
    )
    .expect("外部改写");
    let mentions = vault.mentions_to("Topic.md").expect("旧索引不应让阅读崩溃");
    assert_eq!(mentions.linked.len(), 1);
    assert_eq!(mentions.linked[0].snippet, "中文段落已经由外部工具改写。");
}

#[test]
fn unlinked_skips_fenced_and_inline_code() {
    let (_root, _index, vault) = vault_with(&[
        ("Topic.md", "# Topic\n"),
        (
            "Other.md",
            "plain Topic here\n\n```\nTopic in fence\n```\n\n`Topic inline`\n",
        ),
    ]);
    let mentions = vault.mentions_to("Topic.md").expect("提及");
    assert!(mentions.linked.is_empty());
    assert_eq!(mentions.unlinked.len(), 1);
    let hit = &mentions.unlinked[0];
    assert_eq!(hit.from_path, "Other.md");
    assert_eq!(hit.kind, MentionKind::Unlinked);
    assert!(hit.snippet.contains("plain Topic here"));
    assert!(!hit.snippet.contains("fence"));
    assert!(!hit.snippet.contains("inline"));
}

#[test]
fn unlinked_skips_inline_and_block_math() {
    let (_root, _index, vault) = vault_with(&[
        ("Topic.md", "# Topic\n"),
        (
            "Other.md",
            "plain Topic here\n\n$Topic$\n\n$$\nTopic in display\n$$\n",
        ),
    ]);
    let mentions = vault.mentions_to("Topic.md").expect("提及");
    assert!(mentions.linked.is_empty());
    assert_eq!(mentions.unlinked.len(), 1);
    let hit = &mentions.unlinked[0];
    assert_eq!(hit.from_path, "Other.md");
    assert!(hit.snippet.contains("plain Topic here"));
    assert!(!hit.snippet.contains("display"));
}

#[test]
fn unreadable_markdown_does_not_fail_mentions_to() {
    let (root, _index, vault) = vault_with(&[
        ("Topic.md", "# Topic\n"),
        ("Gone.md", "Topic mentioned\n"),
        ("Keep.md", "Topic also here\n"),
    ]);
    fs::remove_file(root.path().join("Gone.md")).expect("删");
    let mentions = vault.mentions_to("Topic.md").expect("提及");
    assert_eq!(mentions.unlinked.len(), 1);
    assert_eq!(mentions.unlinked[0].from_path, "Keep.md");
}

#[test]
fn missing_source_file_is_omitted_from_linked_mentions() {
    let (root, _index, vault) = vault_with(&[
        ("Topic.md", "# Topic\n"),
        ("Src.md", "See [[Topic]]\n"),
        ("Keep.md", "Also [[Topic]]\n"),
    ]);
    fs::remove_file(root.path().join("Src.md")).expect("删");
    let mentions = vault.mentions_to("Topic.md").expect("提及");
    assert_eq!(mentions.linked.len(), 1);
    assert_eq!(mentions.linked[0].from_path, "Keep.md");
}

#[test]
fn unlinked_skips_ranges_that_are_already_links() {
    let (_root, _index, vault) = vault_with(&[
        ("Topic.md", "# Topic\n"),
        (
            "Mix.md",
            "See [[Topic]] then Topic again. Also [x](./Topic.md) leftover Topic.\n",
        ),
        ("Alias.md", "Display [[Other|Topic]] only.\n"),
        ("Other.md", "# Other\n"),
    ]);
    let mentions = vault.mentions_to("Topic.md").expect("提及");
    assert_eq!(mentions.linked.len(), 2);
    assert!(mentions
        .linked
        .iter()
        .all(|item| item.from_path == "Mix.md"));
    let unlinked: Vec<&str> = mentions
        .unlinked
        .iter()
        .map(|item| item.from_path.as_str())
        .collect();
    assert_eq!(unlinked, ["Mix.md", "Mix.md"]);
    assert!(mentions
        .unlinked
        .iter()
        .all(|item| item.snippet.contains("Topic again") || item.snippet.contains("leftover")));
    assert!(!mentions
        .unlinked
        .iter()
        .any(|item| item.from_path == "Alias.md"));
}

#[test]
fn overlapping_title_and_stem_needles_keep_one_range() {
    let (_root, _index, vault) = vault_with(&[
        ("Note.md", "# Note Title\n"),
        ("Other.md", "Note Title shows up once.\n"),
    ]);
    let mentions = vault.mentions_to("Note.md").expect("提及");
    assert!(mentions.linked.is_empty());
    assert_eq!(mentions.unlinked.len(), 1);
    let hit = &mentions.unlinked[0];
    assert_eq!(hit.from_path, "Other.md");
    assert_eq!(
        hit.end_byte - hit.start_byte,
        i64::try_from("Note Title".len()).expect("len")
    );
}

#[test]
fn needles_shorter_than_two_chars_are_dropped() {
    let (_root, _index, vault) = vault_with(&[
        ("A.md", "# A\n"),
        ("Other.md", "A appears in many places as a letter.\n"),
    ]);
    let mentions = vault.mentions_to("A.md").expect("提及");
    assert!(mentions.unlinked.is_empty());
}

#[test]
fn current_file_is_excluded_from_unlinked_mentions() {
    let (_root, _index, vault) = vault_with(&[(
        "Self.md",
        "# UniqueTitle\n\nUniqueTitle also appears in the body.\n",
    )]);
    let mentions = vault.mentions_to("Self.md").expect("提及");
    assert!(mentions.linked.is_empty());
    assert!(mentions.unlinked.is_empty());
}

#[test]
fn unlinked_is_case_insensitive_and_uses_heading_title() {
    let (_root, _index, vault) = vault_with(&[
        ("file.md", "# Display Name\n"),
        ("Other.md", "see display name in passing.\n"),
    ]);
    let mentions = vault.mentions_to("file.md").expect("提及");
    assert_eq!(mentions.unlinked.len(), 1);
    assert_eq!(mentions.unlinked[0].from_title, "Other");
    assert!(mentions.unlinked[0].snippet.contains("display name"));
}

fn skip_fixture() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../test/notes/vault/fixtures/links/unlinked_skip.md");
    fs::read_to_string(path).expect("夹具")
}

#[test]
fn shared_fixture_skips_code_math_and_existing_links() {
    let body = skip_fixture();
    let (_root, _index, vault) = vault_with(&[("Topic.md", "# Topic\n"), ("Other.md", &body)]);
    let mentions = vault.mentions_to("Topic.md").expect("提及");
    assert_eq!(mentions.linked.len(), 1);
    assert_eq!(mentions.unlinked.len(), 2);
    assert!(mentions.unlinked[0].snippet.contains("plain Topic here"));
    assert!(mentions.unlinked[1].snippet.contains("leftover Topic"));
    assert!(!mentions
        .unlinked
        .iter()
        .any(|item| item.snippet.contains("fence")));
    assert!(!mentions
        .unlinked
        .iter()
        .any(|item| item.snippet.contains("display")));
}
