//! 书签类型转换与持久化操作的 Node-API 适配。

use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::runtime::with_vault;
use noemori_vault::Vault;

/// 一条书签；`kind` 为 `file`/`folder`（`path`）、`heading`（`path` 与 `heading`）或 `search`（`query`）。
#[napi(object)]
pub struct JsBookmark {
    /// 书签种类。
    pub kind: String,
    /// 库内相对路径；文件、文件夹与标题书签必填。
    pub path: Option<String>,
    /// 标题原文；只用于标题书签。
    pub heading: Option<String>,
    /// 查询文本；只用于搜索书签。
    pub query: Option<String>,
    /// 自定义显示名。
    pub title: Option<String>,
}

fn js_bookmark(bookmark: noemori_vault::Bookmark) -> JsBookmark {
    use noemori_vault::Bookmark;
    let (kind, path, heading, query, title) = match bookmark {
        Bookmark::File { path, title } => ("file", Some(path), None, None, title),
        Bookmark::Folder { path, title } => ("folder", Some(path), None, None, title),
        Bookmark::Heading {
            path,
            heading,
            title,
        } => ("heading", Some(path), Some(heading), None, title),
        Bookmark::Search { query, title } => ("search", None, None, Some(query), title),
    };
    JsBookmark {
        kind: kind.to_string(),
        path,
        heading,
        query,
        title,
    }
}

fn core_bookmark(bookmark: JsBookmark) -> Result<noemori_vault::Bookmark> {
    use noemori_vault::Bookmark;
    let missing = |field: &str| Error::from_reason(format!("书签缺少字段 {field}"));
    Ok(match bookmark.kind.as_str() {
        "file" => Bookmark::File {
            path: bookmark.path.ok_or_else(|| missing("path"))?,
            title: bookmark.title,
        },
        "folder" => Bookmark::Folder {
            path: bookmark.path.ok_or_else(|| missing("path"))?,
            title: bookmark.title,
        },
        "heading" => Bookmark::Heading {
            path: bookmark.path.ok_or_else(|| missing("path"))?,
            heading: bookmark.heading.ok_or_else(|| missing("heading"))?,
            title: bookmark.title,
        },
        "search" => Bookmark::Search {
            query: bookmark.query.ok_or_else(|| missing("query"))?,
            title: bookmark.title,
        },
        _ => return Err(Error::from_reason("未知的书签种类")),
    })
}

/// 读出库内书签；文件不存在时为空。
///
/// # Errors
///
/// 未打开库、读盘失败或书签文件损坏。
#[napi]
pub fn bookmarks_list() -> Result<Vec<JsBookmark>> {
    let items = with_vault(Vault::bookmarks)?;
    Ok(items.into_iter().map(js_bookmark).collect())
}

/// 整体替换书签清单；损坏的旧文件先备份再覆盖。
///
/// # Errors
///
/// 未打开库、书签字段无效或写盘失败。
#[napi]
pub fn bookmarks_set(items: Vec<JsBookmark>) -> Result<()> {
    let items = items
        .into_iter()
        .map(core_bookmark)
        .collect::<Result<Vec<_>>>()?;
    with_vault(|vault| vault.set_bookmarks(&items))
}
