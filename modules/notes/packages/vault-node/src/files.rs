//! 文件快照、保存冲突与恢复草稿的 Node-API 适配。

use crate::runtime::{to_napi, with_vault, NativeRuntime};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use noemori_vault::WriteOutcome;

#[napi]
impl NativeRuntime {
    /// 读取文件原始字节。
    ///
    /// # Errors
    ///
    /// 未打开库、越界或不存在。
    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn file_read(&self, env: Env, rel: String) -> Result<Object> {
        self.read(env, move |vault| {
            with_vault(vault, |vault| vault.read(&rel)).map(Buffer::from)
        })
    }
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

#[napi]
impl NativeRuntime {
    /// 获取 `rel` 的磁盘内容与恢复草稿。
    ///
    /// # Errors
    ///
    /// 未打开库、越界或读取失败。
    #[napi(ts_return_type = "Promise<JsFileSnapshot>")]
    pub fn file_snapshot(&self, env: Env, rel: String) -> Result<Object> {
        self.read(env, move |vault| {
            let snapshot = with_vault(vault, |vault| vault.snapshot(&rel))?;
            Ok(JsFileSnapshot {
                disk: snapshot.disk.map(Buffer::from),
                disk_error: snapshot.disk_error,
                draft: snapshot.draft.map(|draft| JsDraft {
                    bytes: Buffer::from(draft.bytes),
                    base: draft.base.map(Buffer::from),
                    editor: draft.editor,
                }),
            })
        })
    }
}

#[napi]
impl NativeRuntime {
    /// 持久化带版本的编辑恢复数据，保持原笔记字节不变。
    ///
    /// # Errors
    /// 未打开库、路径或数据非法、恢复记录冲突或数据库不可写。
    #[napi(ts_return_type = "Promise<void>")]
    pub fn file_preserve_draft(
        &self,
        env: Env,
        rel: String,
        source: Buffer,
        expected: Option<Buffer>,
        editor: String,
    ) -> Result<Object> {
        let source = source.to_vec();
        let expected = expected.map(|b| b.to_vec());
        self.write(env, true, move |state| {
            let vault = state.vault().map_err(to_napi)?;
            with_vault(vault, |vault| {
                vault.preserve_editor_draft(&rel, source.as_ref(), expected.as_deref(), &editor)
            })
        })
    }
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

#[napi]
impl NativeRuntime {
    /// 按 `expected` 基准保存 `bytes`，返回提交状态或冲突。
    ///
    /// # Errors
    ///
    /// 未打开库、越界、草稿持久化或内容提交失败。
    #[napi(ts_return_type = "Promise<JsWriteResult>")]
    pub fn file_write(
        &self,
        env: Env,
        rel: String,
        bytes: Buffer,
        expected: Option<Buffer>,
    ) -> Result<Object> {
        let bytes = bytes.to_vec();
        let expected = expected.map(|b| b.to_vec());
        self.write(env, true, move |state| {
            let result = state
                .write_file(&rel, bytes.as_ref(), expected.as_deref())
                .map_err(to_napi)?;
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
        })
    }
}

/// 新副本的路径与提交后警告。
#[napi(object)]
pub struct JsSavedCopy {
    /// 实际创建的相对路径。
    pub path: String,
    /// 内容已保存后的警告。
    pub warning: Option<String>,
}

#[napi]
impl NativeRuntime {
    /// 将当前 `bytes` 写入唯一命名的新副本，`expected` 用于恢复基准。
    ///
    /// # Errors
    ///
    /// 未打开库、路径非法或副本提交失败。
    #[napi(ts_return_type = "Promise<JsSavedCopy>")]
    pub fn file_write_copy(
        &self,
        env: Env,
        rel: String,
        bytes: Buffer,
        expected: Option<Buffer>,
    ) -> Result<Object> {
        let bytes = bytes.to_vec();
        let expected = expected.map(|b| b.to_vec());
        self.write(env, true, move |state| {
            let copy = state
                .write_copy(&rel, bytes.as_ref(), expected.as_deref())
                .map_err(to_napi)?;
            Ok(JsSavedCopy {
                path: copy.path,
                warning: copy.warning,
            })
        })
    }
}
