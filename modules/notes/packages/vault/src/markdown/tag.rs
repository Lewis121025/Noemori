//! 行内 `#tag` 提取规则。
//!
//! 语义对齐 Obsidian，规则表如下（TS 侧编辑器分词器落地时必须逐条对齐，
//! 共享夹具 `test/notes/vault/fixtures/search/inline-tags.md`）：
//!
//! 1. 提取范围仅限 mdast `Text` 节点的源字节区间；代码、行内代码、数学、
//!    HTML、frontmatter、链接 URL 与定义天然被排除。
//! 2. `[[note#锚点]]` 等 wiki 链接区间内的 `#` 不是标签（按字节区间剔除）。
//! 3. `#` 前一个字符不能是 ASCII 字母数字、下划线或 `#`
//!    （`abc#x`、`##x` 不算标签；CJK 后跟 `#标签` 算，与 Obsidian 一致）；
//!    奇数个反斜杠转义的 `\#x` 也不算。
//! 4. 标签内容为 Unicode 字母数字、`_`、`-`、`/`（嵌套），不能以 `/` 结尾，
//!    且必须含至少一个 Unicode 字母（纯数字 `#123` 不是标签）。
//! 5. 入库统一小写（Unicode `to_lowercase`），不含 `#` 前缀。

use regex::Regex;
use std::ops::Range;
use std::sync::OnceLock;

/// `#` 起、字母数字开头的分段序列；`/` 只允许出现在分段之间（不能收尾、不能连续）。
///
/// 字符集 = Unicode 字母（`\p{Alphabetic}`，含 CJK）+ 十进制数字 + `_` + `-`。
fn tag_regex() -> &'static Regex {
    static TAG: OnceLock<Regex> = OnceLock::new();
    TAG.get_or_init(|| {
        Regex::new(r"#[\p{Alphabetic}\p{Nd}_-]+(?:/[\p{Alphabetic}\p{Nd}_-]+)*").expect("tag 正则")
    })
}

/// 判断 `#` 前一个字符是否构成合法标签边界。
///
/// ASCII 字母数字、下划线与 `#` 之后的 `#` 不启动标签；奇数个反斜杠
/// 表示 `#` 被转义，同样不启动。行首、空白、标点与 CJK 字符之后都合法。
fn valid_boundary(source: &str, hash_start: usize) -> bool {
    let escapes = source.as_bytes()[..hash_start]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count();
    if escapes % 2 == 1 {
        return false;
    }
    let Some(prev) = source[..hash_start].chars().next_back() else {
        // 源开头。
        return true;
    };
    !(prev.is_ascii_alphanumeric() || prev == '_' || prev == '#')
}

/// 标签内容是否含至少一个 Unicode 字母（排除纯数字标签）。
fn has_letter(tag: &str) -> bool {
    tag.chars().any(char::is_alphabetic)
}

/// 从一篇 Markdown 的 Text 源区间里提取规范化行内标签。
///
/// # 参数
///
/// * `source` 完整源文本。
/// * `text_ranges` mdast `Text` 节点的源字节区间（含实体转义原文）。
/// * `wiki_ranges` wiki 链接的源字节区间；与其重叠的候选一律丢弃。
///
/// # 返回值
///
/// 去重后的规范化标签（小写、无 `#`），按首次出现排序。
#[must_use]
pub(crate) fn inline_tags(
    source: &str,
    text_ranges: &[Range<usize>],
    wiki_ranges: &[Range<usize>],
) -> Vec<String> {
    let regex = tag_regex();
    let mut out: Vec<String> = Vec::new();
    for range in text_ranges {
        let Some(slice) = source.get(range.clone()) else {
            continue;
        };
        for found in regex.find_iter(slice) {
            let start = range.start + found.start();
            let end = range.start + found.end();
            if !valid_boundary(source, start) {
                continue;
            }
            if wiki_ranges
                .iter()
                .any(|wiki| wiki.start < end && start < wiki.end)
            {
                continue;
            }
            let tag = found.as_str()[1..].to_lowercase();
            if !has_letter(&tag) || out.contains(&tag) {
                continue;
            }
            out.push(tag);
        }
    }
    out
}
