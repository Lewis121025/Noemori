//! 标签与属性索引：frontmatter 与行内 `#tag` 共享一张 tags 表。
//!
//! 夹具 `test/notes/vault/fixtures/search/inline-tags.md` 是规则表的权威用例集；
//! TS 侧编辑器分词器落地时必须与本断言集逐条对齐。

use nous_vault::{SearchExpr, SearchQuery, Vault};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn tag_query(tag: &str) -> SearchQuery {
    SearchQuery {
        expr: SearchExpr::Tag(tag.to_string()),
        limit: 0,
    }
}

fn attr_query(key: &str, value: &str) -> SearchQuery {
    SearchQuery {
        expr: SearchExpr::Attr {
            key: key.to_string(),
            value: Some(value.to_string()),
        },
        limit: 0,
    }
}

fn fixture_vault() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../test/notes/vault/fixtures/search");
    for entry in fs::read_dir(&fixtures).expect("夹具目录") {
        let entry = entry.expect("夹具项");
        if entry.file_type().expect("类型").is_file() {
            fs::copy(entry.path(), root.path().join(entry.file_name())).expect("复制夹具");
        }
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn indexed_tags(index: &TempDir, path: &str) -> Vec<String> {
    let conn = rusqlite::Connection::open(index.path().join("index.sqlite")).expect("索引库");
    let mut stmt = conn
        .prepare("SELECT tag FROM tags WHERE path = ?1")
        .expect("准备");
    let rows = stmt
        .query_map([path], |row| row.get::<_, String>(0))
        .expect("查询");
    rows.map(|row| row.expect("行")).collect()
}

fn indexed_attributes(index: &TempDir, path: &str) -> Vec<(String, String)> {
    let conn = rusqlite::Connection::open(index.path().join("index.sqlite")).expect("索引库");
    let mut stmt = conn
        .prepare("SELECT key, value FROM attributes WHERE path = ?1")
        .expect("准备");
    let rows = stmt
        .query_map([path], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("查询");
    rows.map(|row| row.expect("行")).collect()
}

#[test]
fn inline_tag_rules_match_fixture_expectations() {
    let (_root, index, _vault) = fixture_vault();
    let mut tags = indexed_tags(&index, "inline-tags.md");
    tags.sort();
    assert_eq!(
        tags,
        [
            // frontmatter：tags/tag 键、`#` 前缀剥离、纯数字丢弃；
            // 行内：标题内、正文、大小写规范化、嵌套、CJK、标点收尾、
            // 反斜杠双转义、链接标签内。整体按字典序。
            "comma",
            "ends-here",
            "escaped",
            "front",
            "hashed",
            "heading-tag",
            "link-label-tag",
            "nested/deep/tag",
            "nested/one",
            "plain",
            "slash",
            "split",
            "upper",
            "日本語",
            "标签",
        ]
    );
}

#[test]
fn frontmatter_attributes_flatten_nested_maps_with_dot_keys() {
    let (_root, index, _vault) = fixture_vault();
    let mut attributes = indexed_attributes(&index, "inline-tags.md");
    attributes.sort();
    assert_eq!(
        attributes,
        [
            ("draft".to_string(), "false".to_string()),
            // 夹具的 list 含嵌套数组元素 → 含复合元素的序列按下标展平；
            // 下标 2 的扁平数组每元素一行。
            ("list.0".to_string(), "one".to_string()),
            ("list.1".to_string(), "two".to_string()),
            ("list.2".to_string(), "me".to_string()),
            ("list.2".to_string(), "skip".to_string()),
            ("nestedmap.key".to_string(), "value".to_string()),
            ("priority".to_string(), "2".to_string()),
            ("status".to_string(), "active".to_string()),
        ]
    );
}

#[test]
fn nested_structures_flatten_by_dot_and_index_with_depth_limit() {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    fs::write(
        root.path().join("deep.md"),
        [
            "---",
            "author:",
            "  name: 张三",
            "  contact:",
            "    email: a@b.c",
            "    deep:",
            "      x: 1",
            "      y:",
            "        z: dropped",
            "mixed:",
            "  - name: 项一",
            "  - 3",
            "---",
            "",
            "正文",
            "",
        ]
        .join("\n"),
    )
    .expect("写夹具");
    let _vault = Vault::open(root.path(), index.path()).expect("打开");
    let mut attributes = indexed_attributes(&index, "deep.md");
    attributes.sort();
    assert_eq!(
        attributes,
        [
            // 4 段键是上限：author.contact.deep.x 保留，y.z（5 段）丢弃。
            ("author.contact.deep.x".to_string(), "1".to_string()),
            ("author.contact.email".to_string(), "a@b.c".to_string()),
            ("author.name".to_string(), "张三".to_string()),
            ("mixed.0.name".to_string(), "项一".to_string()),
            ("mixed.1".to_string(), "3".to_string()),
        ]
    );
}

#[test]
fn dotted_attribute_keys_are_searchable() {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    fs::write(
        root.path().join("a.md"),
        "---\nauthor:\n  name: 张三\n---\n\n正文\n",
    )
    .expect("写夹具");
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    let hits = vault
        .search(&attr_query("author.name", "张三"))
        .expect("检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "a.md");
}

#[test]
fn tag_search_is_case_insensitive() {
    let (_root, _index, vault) = fixture_vault();
    let hits = vault.search(&tag_query("PLAIN")).expect("检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "inline-tags.md");
}

#[test]
fn ancestor_tag_prefix_matches_nested_tags() {
    let (_root, _index, vault) = fixture_vault();
    // `nested` 命中 `nested/one` 与 `nested/deep/tag`（Obsidian 语义）。
    let hits = vault.search(&tag_query("nested")).expect("检索");
    assert_eq!(hits.len(), 1);
    // 精确子标签同样命中；`nested/o` 这样的半截前缀不命中。
    let exact = vault.search(&tag_query("nested/one")).expect("检索");
    assert_eq!(exact.len(), 1);
    let partial = vault.search(&tag_query("nested/o")).expect("检索");
    assert!(partial.is_empty());
}

#[test]
fn unknown_tag_and_hash_prefixed_query_still_work() {
    let (_root, _index, vault) = fixture_vault();
    let missing = vault.search(&tag_query("does-not-exist")).expect("检索");
    assert!(missing.is_empty());
    // 查询侧带 `#` 前缀等价于不带。
    let hashed = vault.search(&tag_query("#front")).expect("检索");
    assert_eq!(hashed.len(), 1);
}
