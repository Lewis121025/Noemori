//! 链接解析、入链、出链与提及的 Node-API 适配。

use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::runtime::with_vault;
use nous_vault::LinkKind;
use crate::entries::JsRenameOutcome;

/// 链接解析结果：路径、锚点与歧义候选分开返回。
#[napi(object)]
pub struct JsLinkTarget {
    /// `resolved`、`ambiguous` 或 `dead`。
    pub status: String,
    /// 唯一命中的库内路径；仅 `resolved` 提供。
    pub path: Option<String>,
    /// 歧义候选路径（升序）；仅 `ambiguous` 提供。
    pub candidates: Option<Vec<String>>,
    /// 已解码的标题锚点；无锚点为缺失。
    pub anchor: Option<String>,
}

/// 解析链接目标。
///
/// `kind` 为 `wiki` 或 `md`。歧义时返回全部候选，由界面让用户选择。
///
/// # Errors
///
/// 未打开库或 kind 非法。
#[napi]
pub fn links_resolve(from: String, raw: String, kind: String) -> Result<JsLinkTarget> {
    let kind: LinkKind = kind
        .parse()
        .map_err(|()| Error::from_reason("未知链接种类"))?;
    with_vault(|vault| {
        Ok(match vault.resolve_link(&from, &raw, kind) {
            nous_vault::LinkTarget::Resolved { path, anchor } => JsLinkTarget {
                status: "resolved".into(),
                path: Some(path),
                candidates: None,
                anchor,
            },
            nous_vault::LinkTarget::Ambiguous { candidates, anchor } => JsLinkTarget {
                status: "ambiguous".into(),
                path: None,
                candidates: Some(candidates),
                anchor,
            },
            nous_vault::LinkTarget::Dead => JsLinkTarget {
                status: "dead".into(),
                path: None,
                candidates: None,
                anchor: None,
            },
        })
    })
}

/// 一条索引中的链接。
#[napi(object)]
pub struct JsLinkRecord {
    /// 源文件相对路径。
    pub from_path: String,
    /// 链接原文中的目标。
    pub to_raw: String,
    /// 解析到的路径；死链、歧义和纯锚点为 `null`。
    pub to_path: Option<String>,
    /// `wiki` 或 `md`。
    pub kind: String,
    /// 字节区间起点（含）。
    pub start_byte: i64,
    /// 字节区间终点（不含）。
    pub end_byte: i64,
    /// `resolved`、`ambiguous`、`dead` 或 `self`。
    pub resolution: String,
}

fn to_js(link: nous_vault::LinkRecord) -> JsLinkRecord {
    JsLinkRecord {
        from_path: link.from_path,
        to_raw: link.to_raw,
        to_path: link.to_path,
        kind: link.kind.as_str().to_string(),
        start_byte: link.start_byte,
        end_byte: link.end_byte,
        resolution: link.resolution.as_str().to_string(),
    }
}

/// 一条已链接或未链接提及。
#[napi(object)]
pub struct JsMentionRecord {
    /// 源文件相对路径。
    pub from_path: String,
    /// 源文件展示标题。
    pub from_title: String,
    /// 源文件内容修改时间（自纪元起的纳秒）。
    pub mtime: i64,
    /// 命中区间起点（含）。
    pub start_byte: i64,
    /// 命中区间终点（不含）。
    pub end_byte: i64,
    /// 命中所在段落。
    pub snippet: String,
    /// `linked` 或 `unlinked`。
    pub kind: String,
    /// 已链接时为 `wiki`/`md`；未链接为 `null`。
    pub link_kind: Option<String>,
    /// 已链接为链接原文目标；未链接为命中文本。
    pub to_raw: String,
}

/// 指向一篇笔记的已链接与未链接提及。
#[napi(object)]
pub struct JsMentions {
    /// 索引里的入链。
    pub linked: Vec<JsMentionRecord>,
    /// 正文里尚未做成链接的出现。
    pub unlinked: Vec<JsMentionRecord>,
}

fn to_js_mention(mention: nous_vault::MentionRecord) -> JsMentionRecord {
    JsMentionRecord {
        from_path: mention.from_path,
        from_title: mention.from_title,
        mtime: mention.mtime,
        start_byte: mention.start_byte,
        end_byte: mention.end_byte,
        snippet: mention.snippet,
        kind: mention.kind.as_str().to_string(),
        link_kind: mention.link_kind.map(|kind| kind.as_str().to_string()),
        to_raw: mention.to_raw,
    }
}

/// 指向 `path` 的入链。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_links_to(path: String) -> Result<Vec<JsLinkRecord>> {
    Ok(with_vault(|vault| vault.links_to(&path))?
        .into_iter()
        .map(to_js)
        .collect())
}

/// `path` 的出链。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_links_from(path: String) -> Result<Vec<JsLinkRecord>> {
    Ok(with_vault(|vault| vault.links_from(&path))?
        .into_iter()
        .map(to_js)
        .collect())
}

/// 指向 `path` 的已链接提及与未链接提及。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_mentions_to(path: String) -> Result<JsMentions> {
    let mentions = with_vault(|vault| vault.mentions_to(&path))?;
    Ok(JsMentions {
        linked: mentions.linked.into_iter().map(to_js_mention).collect(),
        unlinked: mentions.unlinked.into_iter().map(to_js_mention).collect(),
    })
}

/// 把 `from` 文件里 `[start_byte, end_byte)` 的未链接提及就地转为指向
/// `target` 的 wiki 链接；`expected` 是查询时的提及文本，文件已变化时拒绝。
///
/// # Errors
///
/// 未打开库、目标不在库内、区间过期或写盘失败。
#[napi]
pub fn mentions_linkify(
    from: String,
    start_byte: i64,
    end_byte: i64,
    expected: String,
    target: String,
) -> Result<JsRenameOutcome> {
    let result =
        with_vault(|vault| vault.linkify_mention(&from, start_byte, end_byte, &expected, &target))?;
    Ok(JsRenameOutcome {
        warning: result.warning,
    })
}
