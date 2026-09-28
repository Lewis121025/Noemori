//! 文件树条目与改名、删除操作的 Node-API 适配。

use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::runtime::with_vault;
use nous_vault::Vault;

/// 列出库内相对路径。
///
/// # Errors
///
/// 未打开库或读目录失败。
#[napi]
pub fn vault_list() -> Result<Vec<String>> {
    with_vault(Vault::list_files)
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
}

impl From<nous_vault::VaultEntry> for JsVaultEntry {
    fn from(entry: nous_vault::VaultEntry) -> Self {
        Self {
            path: entry.path,
            kind: match entry.kind {
                nous_vault::EntryKind::File => "file",
                nous_vault::EntryKind::Directory => "directory",
            }
            .into(),
            recovery_only: entry.recovery_only.then_some(true),
        }
    }
}

/// 列出完整目录；未打开库或目录读取失败时返回错误。
#[napi]
pub fn vault_entries() -> Result<Vec<JsVaultEntry>> {
    Ok(with_vault(Vault::list_entries)?
        .into_iter()
        .map(JsVaultEntry::from)
        .collect())
}

/// 创建笔记或文件夹；`content` 是文件初始字节（缺省为空），创建与写入
/// 是同一次独占提交。非法类型、同名目标、目录携带内容或磁盘失败时拒绝。
#[napi]
pub fn entry_create(
    path: String,
    kind: String,
    content: Option<Buffer>,
) -> Result<JsRenameOutcome> {
    let kind = match kind.as_str() {
        "file" => nous_vault::EntryKind::File,
        "directory" => nous_vault::EntryKind::Directory,
        _ => return Err(Error::from_reason("未知条目类型")),
    };
    let content = content.map(|buffer| buffer.to_vec());
    Ok(JsRenameOutcome {
        warning: with_vault(|vault| {
            vault.create_entry(&path, kind, content.as_deref().unwrap_or(&[]))
        })?
        .warning,
    })
}

/// 移入系统废纸篓；失败不退化为永久删除，未保存草稿阻止操作。
#[napi]
pub fn entry_trash(path: String) -> Result<JsRenameOutcome> {
    let result = with_vault(|vault| {
        vault.trash_entry(&path, |absolute| {
            trash::delete(absolute)
                .map_err(|error| nous_vault::Error::Io(std::io::Error::other(error.to_string())))
        })
    })?;
    Ok(JsRenameOutcome {
        warning: result.warning,
    })
}

/// 批量预检的独立条目，不包含未经确认的覆盖或永久删除选项。
#[napi(object)]
pub struct JsEntryMutation {
    /// 规范的库内源路径。
    pub from: String,
    /// 缺席表示废纸篓操作，否则为规范移动目标。
    pub to: Option<String>,
}

/// 预检整批操作；不修改用户文件，路径、草稿或目标冲突通过异常返回。
#[napi]
pub fn entry_check_batch(changes: Vec<JsEntryMutation>) -> Result<()> {
    let changes: Vec<_> = changes
        .into_iter()
        .map(|change| nous_vault::EntryMutation {
            from: change.from,
            to: change.to,
        })
        .collect();
    with_vault(|vault| vault.check_entry_batch(&changes))
}

/// 获取经过库根校验的现有路径，只供主进程调用系统文件管理器。
#[napi]
pub fn entry_path(path: String) -> Result<String> {
    Ok(with_vault(|vault| vault.entry_path(&path))?
        .to_string_lossy()
        .into_owned())
}

/// 文件已经完成改名，索引或日志清理可能仍需重试。
#[napi(object)]
pub struct JsRenameOutcome {
    /// 提交后的警告；无警告时缺失。
    pub warning: Option<String>,
}

/// 将 `from` 改名为 `to` 并更新全库链接，返回提交后的警告。
///
/// # Errors
///
/// 未打开库、目标已存在或写盘失败。
#[napi]
pub fn entry_rename(from: String, to: String) -> Result<JsRenameOutcome> {
    let result = with_vault(|vault| vault.rename(&from, &to))?;
    Ok(JsRenameOutcome {
        warning: result.warning,
    })
}
