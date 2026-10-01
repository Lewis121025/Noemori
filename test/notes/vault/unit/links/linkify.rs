//! 未链接提及就地转链接：字节区间替换、别名保留、歧义回退与过期拒绝。

use noemori_vault::{Error, Vault};
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

fn first_unlinked(vault: &Vault, target: &str) -> (i64, i64, String) {
    let mentions = vault.mentions_to(target).expect("提及");
    let unlinked = mentions.unlinked.first().expect("应有未链接提及");
    (
        unlinked.start_byte,
        unlinked.end_byte,
        unlinked.to_raw.clone(),
    )
}

#[test]
fn linkify_replaces_only_the_mention_range_and_updates_index() {
    let (root, _index, vault) =
        vault_with(&[("目标.md", "# 目标\n"), ("ref.md", "开头 目标 结尾\n")]);
    let (start, end, text) = first_unlinked(&vault, "目标.md");
    let outcome = vault
        .linkify_mention("ref.md", start, end, &text, "目标.md")
        .expect("转链接");
    assert_eq!(outcome.warning, None);
    assert_eq!(
        fs::read_to_string(root.path().join("ref.md")).expect("读"),
        "开头 [[目标]] 结尾\n"
    );
    // 索引同步：目标获得入链，未链接提及消失。
    let links = vault.links_to("目标.md").expect("入链");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].from_path, "ref.md");
    let after = vault.mentions_to("目标.md").expect("提及");
    assert!(after.unlinked.is_empty());
    assert_eq!(after.linked.len(), 1);
}

#[test]
fn linkify_in_chinese_quote_preserves_prefix_and_line_endings() {
    let original = "> 前文\r\n> 中文阅读内容\r\n";
    let (root, _index, vault) = vault_with(&[("阅读.md", "# 阅读\n"), ("资料.md", original)]);
    let (start, end, text) = first_unlinked(&vault, "阅读.md");
    assert_eq!(text, "阅读");
    vault
        .linkify_mention("资料.md", start, end, &text, "阅读.md")
        .expect("准确替换原文字节");
    assert_eq!(
        fs::read_to_string(root.path().join("资料.md")).expect("读回"),
        "> 前文\r\n> 中文[[阅读]]内容\r\n"
    );
}

#[test]
fn title_mentions_keep_the_sentence_as_alias() {
    let (root, _index, vault) = vault_with(&[
        ("design.md", "# 设计笔记\n"),
        ("ref.md", "参见 设计笔记 一节\n"),
    ]);
    let (start, end, text) = first_unlinked(&vault, "design.md");
    assert_eq!(text, "设计笔记");
    vault
        .linkify_mention("ref.md", start, end, &text, "design.md")
        .expect("转链接");
    // 提及文本 ≠ 词干：别名保留原句，链接目标用唯一词干。
    assert_eq!(
        fs::read_to_string(root.path().join("ref.md")).expect("读"),
        "参见 [[design|设计笔记]] 一节\n"
    );
    let links = vault.links_to("design.md").expect("入链");
    assert_eq!(links[0].to_raw, "design");
}

#[test]
fn ambiguous_stems_fall_back_to_path_form() {
    let (root, _index, vault) = vault_with(&[
        ("a/目标.md", "甲\n"),
        ("b/目标.md", "乙\n"),
        ("ref.md", "x 目标 y\n"),
    ]);
    let (start, end, text) = first_unlinked(&vault, "a/目标.md");
    vault
        .linkify_mention("ref.md", start, end, &text, "a/目标.md")
        .expect("转链接");
    // 裸词干歧义时用去扩展名的路径形式，不制造新的歧义链接。
    assert_eq!(
        fs::read_to_string(root.path().join("ref.md")).expect("读"),
        "x [[a/目标]] y\n"
    );
    assert_eq!(vault.links_to("a/目标.md").expect("入链").len(), 1);
    assert!(vault.links_to("b/目标.md").expect("入链").is_empty());
}

#[test]
fn stale_ranges_are_rejected_without_touching_bytes() {
    let (root, _index, vault) =
        vault_with(&[("目标.md", "# 目标\n"), ("ref.md", "开头 目标 结尾\n")]);
    let (start, end, text) = first_unlinked(&vault, "目标.md");
    fs::write(root.path().join("ref.md"), "完全不同的内容 目标\n").expect("外部改写");
    let err = vault
        .linkify_mention("ref.md", start, end, &text, "目标.md")
        .expect_err("应拒绝过期区间");
    assert!(matches!(err, Error::FileChanged { .. }));
    assert_eq!(
        fs::read_to_string(root.path().join("ref.md")).expect("读"),
        "完全不同的内容 目标\n"
    );
}

#[test]
fn non_markdown_sources_and_unknown_targets_are_rejected() {
    let (_root, _index, vault) = vault_with(&[
        ("目标.md", "# 目标\n"),
        ("ref.txt", "开头 目标 结尾\n"),
        ("ref.md", "开头 目标 结尾\n"),
    ]);
    let err = vault
        .linkify_mention("ref.txt", 7, 13, "目标", "目标.md")
        .expect_err("非 Markdown 应拒绝");
    assert!(matches!(err, Error::Io(_)));
    let err = vault
        .linkify_mention("ref.md", 7, 13, "目标", "缺席.md")
        .expect_err("库外目标应拒绝");
    assert!(matches!(err, Error::NotFound { .. }));
}

#[test]
fn special_characters_in_mentions_are_entity_encoded() {
    let (root, _index, vault) = vault_with(&[("A&B.md", "note\n"), ("ref.md", "引用 A&B 记录\n")]);
    let (start, end, text) = first_unlinked(&vault, "A&B.md");
    assert_eq!(text, "A&B");
    vault
        .linkify_mention("ref.md", start, end, &text, "A&B.md")
        .expect("转链接");
    // 词干含 & ：实体编码写回，解析端与扫描端使用同一套语义。
    let written = fs::read_to_string(root.path().join("ref.md")).expect("读");
    assert!(written.contains("&#38;"), "{written}");
    assert_eq!(vault.links_to("A&B.md").expect("入链").len(), 1);
}
