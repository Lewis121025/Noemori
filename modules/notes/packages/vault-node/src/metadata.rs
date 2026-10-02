//! 标题、标签及笔记身份的 Node-API 适配。

use crate::runtime::{with_vault, NativeRuntime};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use noemori_vault::Vault;

/// 索引里的一条标题记录。
#[napi(object)]
pub struct JsHeadingRecord {
    /// 源文件相对路径。
    pub path: String,
    /// 标题等级（1–6）。
    pub level: i64,
    /// 去除行内语法后的标题纯文本。
    pub text: String,
    /// 字节区间起点（含）。
    pub start_byte: i64,
    /// 字节区间终点（不含）。
    pub end_byte: i64,
}

/// 全库标签计数的一行。
#[napi(object)]
pub struct JsTagCount {
    /// 规范化标签（小写、无 `#`）。
    pub tag: String,
    /// 携带该标签的文件数。
    pub count: i64,
}

#[napi]
impl NativeRuntime {
    /// 全库标签及计数，标签升序；供标签浏览面板。
    ///
    /// # Errors
    ///
    /// 未打开库。
    #[napi(ts_return_type = "Promise<Array<JsTagCount>>")]
    pub fn index_tags(&self, env: Env) -> Result<Object> {
        self.read(env, move |vault| {
            let counts = with_vault(vault, Vault::tag_counts)?;
            Ok(counts
                .into_iter()
                .map(|count| JsTagCount {
                    tag: count.tag,
                    count: count.count,
                })
                .collect::<Vec<_>>())
        })
    }
}

/// 一篇笔记可被点名的标题与别名。
#[napi(object)]
pub struct JsNoteKeys {
    /// 库内相对路径。
    pub path: String,
    /// 展示标题：文首一级标题，缺失时为文件名词干。
    pub title: String,
    /// frontmatter 别名，按书写顺序。
    pub aliases: Vec<String>,
}

#[napi]
impl NativeRuntime {
    /// 全部 Markdown 笔记的标题与别名，路径升序；供快速切换器与别名补全。
    ///
    /// # Errors
    ///
    /// 未打开库或索引查询失败。
    #[napi(ts_return_type = "Promise<Array<JsNoteKeys>>")]
    pub fn index_note_keys(&self, env: Env) -> Result<Object> {
        self.read(env, move |vault| {
            let keys = with_vault(vault, Vault::note_keys)?;
            Ok(keys
                .into_iter()
                .map(|note| JsNoteKeys {
                    path: note.path,
                    title: note.title,
                    aliases: note.aliases,
                })
                .collect::<Vec<_>>())
        })
    }
}

#[napi]
impl NativeRuntime {
    /// `path` 的全部标题，按文档顺序；供锚点解析与标题补全。
    ///
    /// # Errors
    ///
    /// 未打开库。
    #[napi(ts_return_type = "Promise<Array<JsHeadingRecord>>")]
    pub fn index_headings(&self, env: Env, path: String) -> Result<Object> {
        self.read(env, move |vault| {
            let headings = with_vault(vault, |vault| vault.headings(&path))?;
            Ok(headings
                .into_iter()
                .map(|heading| JsHeadingRecord {
                    path: heading.path,
                    level: heading.level,
                    text: heading.text,
                    start_byte: heading.start_byte,
                    end_byte: heading.end_byte,
                })
                .collect::<Vec<_>>())
        })
    }
}
