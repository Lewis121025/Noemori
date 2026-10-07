//! 文件树条目与改名、删除操作的 Node-API 适配。

use crate::runtime::{to_napi, with_vault, NativeRuntime};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use noemori_vault::Vault;

#[napi]
impl NativeRuntime {
    /// 列出库内相对路径。
    ///
    /// # Errors
    ///
    /// 未打开库或读目录失败。
    #[napi(ts_return_type = "Promise<Array<string>>")]
    pub fn vault_list(&self, env: Env) -> Result<Object> {
        self.read(env, move |vault| with_vault(vault, Vault::list_files))
    }
}

/// 文件树条目，包含空文件夹。
#[napi(object)]
pub struct JsVaultEntry {
    /// 库内相对路径。
    pub path: String,
    /// file 或 directory。
    pub kind: String,
    /// 仅在草稿无法对应真实文件条目时设置。
    pub recovery_only: Option<bool>,
    /// 文件索引的 Unix 毫秒修改时间；目录或恢复草稿缺省。
    pub modified_at: Option<f64>,
}

impl From<noemori_vault::VaultEntry> for JsVaultEntry {
    fn from(entry: noemori_vault::VaultEntry) -> Self {
        Self {
            path: entry.path,
            kind: match entry.kind {
                noemori_vault::EntryKind::File => "file",
                noemori_vault::EntryKind::Directory => "directory",
            }
            .into(),
            recovery_only: entry.recovery_only.then_some(true),
            modified_at: entry.modified_at.map(|time| time as f64),
        }
    }
}

#[napi]
impl NativeRuntime {
    /// 列出完整目录；未打开库或目录读取失败时返回错误。
    #[napi(ts_return_type = "Promise<Array<JsVaultEntry>>")]
    pub fn vault_entries(&self, env: Env) -> Result<Object> {
        self.read(env, move |vault| {
            Ok(with_vault(vault, Vault::list_entries)?
                .into_iter()
                .map(JsVaultEntry::from)
                .collect::<Vec<_>>())
        })
    }
}

#[napi]
impl NativeRuntime {
    /// 创建笔记或文件夹；`content` 是文件初始字节（缺省为空），创建与写入
    /// 是同一次独占提交。非法类型、同名目标、目录携带内容或磁盘失败时拒绝。
    #[napi(ts_return_type = "Promise<JsRenameOutcome>")]
    pub fn entry_create(
        &self,
        env: Env,
        path: String,
        kind: String,
        content: Option<Buffer>,
    ) -> Result<Object> {
        let content = content.map(|b| b.to_vec());
        self.write(env, true, move |state| {
            let kind = match kind.as_str() {
                "file" => noemori_vault::EntryKind::File,
                "directory" => noemori_vault::EntryKind::Directory,
                _ => return Err(Error::from_reason("未知条目类型")),
            };
            Ok(JsRenameOutcome {
                warning: state
                    .create_entry(&path, kind, content.as_deref().unwrap_or(&[]))
                    .map_err(to_napi)?
                    .warning,
            })
        })
    }
}

#[napi]
impl NativeRuntime {
    /// 移入系统废纸篓；失败不退化为永久删除，未保存草稿阻止操作。
    #[napi(ts_return_type = "Promise<JsRenameOutcome>")]
    pub fn entry_trash(&self, env: Env, path: String) -> Result<Object> {
        self.write(env, true, move |state| {
            Ok(JsRenameOutcome {
                warning: state.trash(&path).map_err(to_napi)?.warning,
            })
        })
    }
}

#[napi]
impl NativeRuntime {
    /// 获取经过库根校验的现有路径，只供主进程调用系统文件管理器。
    #[napi(ts_return_type = "Promise<string>")]
    pub fn entry_path(&self, env: Env, path: String) -> Result<Object> {
        self.read(env, move |vault| {
            Ok(with_vault(vault, |vault| vault.entry_path(&path))?
                .to_string_lossy()
                .into_owned())
        })
    }
}

/// 文件已经完成改名，索引或日志清理可能仍需重试。
#[napi(object)]
pub struct JsRenameOutcome {
    /// 提交后的警告；无警告时缺失。
    pub warning: Option<String>,
}

#[napi]
impl NativeRuntime {
    /// 将 `from` 改名为 `to` 并更新全库链接，返回提交后的警告。
    ///
    /// # Errors
    ///
    /// 未打开库、目标已存在或写盘失败。
    #[napi(ts_return_type = "Promise<JsRenameOutcome>")]
    pub fn entry_rename(&self, env: Env, from: String, to: String) -> Result<Object> {
        self.write(env, true, move |state| {
            Ok(JsRenameOutcome {
                warning: state.rename(&from, &to).map_err(to_napi)?.warning,
            })
        })
    }
}
