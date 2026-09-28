//! 文件快照、保存冲突与恢复草稿的 Node-API 适配。

use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::runtime::with_vault;
use nous_vault::WriteOutcome;

/// 读取文件原始字节。
///
/// # Errors
///
/// 未打开库、越界或不存在。
#[napi]
pub fn file_read(rel: String) -> Result<Buffer> {
    with_vault(|vault| vault.read(&rel)).map(Buffer::from)
}

/// 已持久化的恢复草稿。
#[napi(object)]
pub struct JsDraft {
    /// 普通草稿为最新内容；存在 editor 时为重建源码映射的原始字节。
    pub bytes: Buffer,
    /// 原编辑基准；缺失表示新文件。
    pub base: Option<Buffer>,
    /// 版本化的编辑器恢复内容；没有时按普通 Markdown 字节恢复。
    pub editor: Option<String>,
}

/// 编辑器加载快照，文件删除时仍可恢复草稿。
#[napi(object)]
pub struct JsFileSnapshot {
    /// 磁盘内容；缺失时通过 disk_error 区分删除与读取失败。
    pub disk: Option<Buffer>,
    /// 原路径不可读时保留草稿，并携带原因。
    pub disk_error: Option<String>,
    /// 尚未提交的编辑。
    pub draft: Option<JsDraft>,
}

/// 获取 `rel` 的磁盘内容与恢复草稿。
///
/// # Errors
///
/// 未打开库、越界或读取失败。
#[napi]
pub fn file_snapshot(rel: String) -> Result<JsFileSnapshot> {
    let snapshot = with_vault(|vault| vault.snapshot(&rel))?;
    Ok(JsFileSnapshot {
        disk: snapshot.disk.map(Buffer::from),
        disk_error: snapshot.disk_error,
        draft: snapshot.draft.map(|draft| JsDraft {
            bytes: Buffer::from(draft.bytes),
            base: draft.base.map(Buffer::from),
            editor: draft.editor,
        }),
    })
}

/// 持久化带版本的编辑恢复数据，保持原笔记字节不变。
///
/// # Errors
/// 未打开库、路径或数据非法、恢复记录冲突或数据库不可写。
#[napi]
pub fn file_preserve_draft(
    rel: String,
    source: Buffer,
    expected: Option<Buffer>,
    editor: String,
) -> Result<()> {
    with_vault(|vault| {
        vault.preserve_editor_draft(&rel, source.as_ref(), expected.as_deref(), &editor)
    })
}

/// 文件提交结果，冲突时附带磁盘版本。
#[napi(object)]
pub struct JsWriteResult {
    /// `saved` 或 `conflict`。
    pub status: String,
    /// 冲突的磁盘字节；缺失也可能表示文件被删除。
    pub disk: Option<Buffer>,
    /// 已提交后的同步、索引或清理警告。
    pub warning: Option<String>,
}

/// 按 `expected` 基准保存 `bytes`，返回提交状态或冲突。
///
/// # Errors
///
/// 未打开库、越界、草稿持久化或内容提交失败。
#[napi]
pub fn file_write(rel: String, bytes: Buffer, expected: Option<Buffer>) -> Result<JsWriteResult> {
    let result = with_vault(|vault| vault.write(&rel, bytes.as_ref(), expected.as_deref()))?;
    Ok(match result {
        WriteOutcome::Saved { warning } => JsWriteResult {
            status: "saved".into(),
            disk: None,
            warning,
        },
        WriteOutcome::Conflict { disk } => JsWriteResult {
            status: "conflict".into(),
            disk: disk.map(Buffer::from),
            warning: None,
        },
    })
}

/// 新副本的路径与提交后警告。
#[napi(object)]
pub struct JsSavedCopy {
    /// 实际创建的相对路径。
    pub path: String,
    /// 内容已保存后的警告。
    pub warning: Option<String>,
}

/// 将当前 `bytes` 写入唯一命名的新副本，`expected` 用于恢复基准。
///
/// # Errors
///
/// 未打开库、路径非法或副本提交失败。
#[napi]
pub fn file_write_copy(
    rel: String,
    bytes: Buffer,
    expected: Option<Buffer>,
) -> Result<JsSavedCopy> {
    let copy = with_vault(|vault| vault.write_copy(&rel, bytes.as_ref(), expected.as_deref()))?;
    Ok(JsSavedCopy {
        path: copy.path,
        warning: copy.warning,
    })
}
