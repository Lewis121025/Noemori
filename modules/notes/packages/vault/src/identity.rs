//! 笔记身份键：文首标题与 frontmatter 别名。
//!
//! 与路径键一样做精确匹配、区分大小写。同一文件内先去重再入表，
//! 避免标题恰好等于文件名时把唯一命中标成歧义。
//! 含 `#`、`|`、方括号或换行的键写不进 wiki 目标，直接丢弃。

use std::collections::HashMap;

use crate::index::FileRow;
use crate::scan::ScannedMarkdown;

/// 把一条身份键追加进文件自己的键列表；空值和非法键忽略。
pub(crate) fn push_key(keys: &mut Vec<String>, raw: &str) {
    let key = raw.trim();
    if key.is_empty() || !is_wiki_key(key) || keys.iter().any(|existing| existing == key) {
        return;
    }
    keys.push(key.to_string());
}

/// `#` 会变成锚点，`|` 与方括号会截断 wiki 语法，这些键无法被点名。
fn is_wiki_key(key: &str) -> bool {
    !key.chars()
        .any(|character| matches!(character, '#' | '|' | '[' | ']' | '\n' | '\r'))
}

/// 从属性行取出 `alias` / `aliases`。
///
/// 逗号分隔的标量与 YAML 序列都收成多条键；属性索引仍保留原文，这里只服务链接解析。
pub(crate) fn alias_keys(attributes: &[(String, String)]) -> Vec<String> {
    let mut keys = Vec::new();
    for (name, value) in attributes {
        if name != "alias" && name != "aliases" {
            continue;
        }
        for part in value.split(',') {
            push_key(&mut keys, part);
        }
    }
    keys
}

/// 一篇已扫描笔记的标题与别名，供改名时重建解析表。
pub(crate) fn keys_from_scan(scanned: &ScannedMarkdown) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(title) = &scanned.title {
        push_key(&mut keys, title);
    }
    for alias in alias_keys(&scanned.attributes) {
        push_key(&mut keys, &alias);
    }
    keys
}

/// 一篇笔记可被点名的身份：展示标题与别名，供快速切换器与别名补全匹配。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteKeys {
    /// 库内相对路径。
    pub path: String,
    /// 展示标题：文首一级标题，缺失时为文件名词干。
    pub title: String,
    /// frontmatter `alias` / `aliases` 的别名，按书写顺序去重。
    pub aliases: Vec<String>,
}

/// 由文件行与别名表组装全部 Markdown 笔记的身份，按路径升序。
pub(crate) fn note_keys(rows: &[FileRow], aliases: &HashMap<String, Vec<String>>) -> Vec<NoteKeys> {
    let mut out: Vec<NoteKeys> = rows
        .iter()
        .filter(|row| row.kind == "markdown")
        .map(|row| NoteKeys {
            path: row.path.clone(),
            title: row.title.clone(),
            aliases: aliases.get(&row.path).cloned().unwrap_or_default(),
        })
        .collect();
    out.sort_by(|left, right| left.path.cmp(&right.path));
    out
}

/// 由文件行标题和别名表生成每篇笔记的额外解析键。
///
/// 文件名回退标题与词干重复，由调用方在并入路径键时再去重。
pub(crate) fn extras_from_files(
    rows: &[FileRow],
    aliases: &HashMap<String, Vec<String>>,
) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    for row in rows {
        if row.kind != "markdown" {
            continue;
        }
        let mut keys = Vec::new();
        push_key(&mut keys, &row.title);
        if let Some(list) = aliases.get(&row.path) {
            for alias in list {
                push_key(&mut keys, alias);
            }
        }
        if !keys.is_empty() {
            out.insert(row.path.clone(), keys);
        }
    }
    out
}
