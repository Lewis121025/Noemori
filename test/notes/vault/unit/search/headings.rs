//! 标题提取：等级、纯文本与源字节区间，锚点解析与补全的数据地基。

use noemori_vault::Vault;
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

fn source_slice(root: &TempDir, rel: &str, start: i64, end: i64) -> String {
    let bytes = fs::read(root.path().join(rel)).expect("读源");
    let start = usize::try_from(start).expect("start");
    let end = usize::try_from(end).expect("end");
    String::from_utf8(bytes[start..end].to_vec()).expect("utf8")
}

#[test]
fn headings_record_levels_text_and_byte_ranges() {
    let body = "# Title\n\ntext\n\n## Section **bold**\n\nmore\n\n### 中文小节\n";
    let (root, _index, vault) = vault_with(&[("note.md", body)]);
    let headings = vault.headings("note.md").expect("标题");
    assert_eq!(headings.len(), 3);
    assert_eq!(headings[0].level, 1);
    assert_eq!(headings[0].text, "Title");
    assert_eq!(headings[1].level, 2);
    // 行内语法剥离后的纯文本；锚点按原文匹配依赖这一点。
    assert_eq!(headings[1].text, "Section bold");
    assert_eq!(headings[2].level, 3);
    assert_eq!(headings[2].text, "中文小节");
    for heading in &headings {
        let slice = source_slice(&root, "note.md", heading.start_byte, heading.end_byte);
        assert!(slice.starts_with('#'), "区间应覆盖标题行首：{slice}");
        assert!(slice.contains(&heading.text[..heading.text.len().min(3)]));
    }
}

#[test]
fn setext_headings_are_recorded_with_text_line_start() {
    let body = "Title Two\n=========\n\nbody\n\nSub\n---\n";
    let (root, _index, vault) = vault_with(&[("setext.md", body)]);
    let headings = vault.headings("setext.md").expect("标题");
    assert_eq!(headings.len(), 2);
    assert_eq!(headings[0].level, 1);
    assert_eq!(headings[0].text, "Title Two");
    assert_eq!(headings[1].level, 2);
    assert_eq!(headings[1].text, "Sub");
    // 起点是文字行而非下划线行，跳转才能落在标题块开头。
    let slice = source_slice(
        &root,
        "setext.md",
        headings[0].start_byte,
        headings[0].end_byte,
    );
    assert!(slice.starts_with("Title Two"));
}

#[test]
fn empty_headings_are_skipped_without_placeholders() {
    let body = "##\n\n# Real\n";
    let (_root, _index, vault) = vault_with(&[("empty.md", body)]);
    let headings = vault.headings("empty.md").expect("标题");
    assert_eq!(headings.len(), 1);
    assert_eq!(headings[0].text, "Real");
}

#[test]
fn headings_inside_blockquotes_are_included_in_document_order() {
    let body = "# First\n\n> ## Quoted\n\n# Last\n";
    let (_root, _index, vault) = vault_with(&[("quote.md", body)]);
    let headings = vault.headings("quote.md").expect("标题");
    let texts: Vec<&str> = headings.iter().map(|h| h.text.as_str()).collect();
    assert_eq!(texts, ["First", "Quoted", "Last"]);
}

#[test]
fn non_markdown_and_missing_files_have_no_headings() {
    let (_root, _index, vault) = vault_with(&[("data.txt", "# not a heading\n")]);
    assert!(vault.headings("data.txt").expect("txt 无标题").is_empty());
    assert!(vault.headings("missing.md").expect("缺失无标题").is_empty());
}
