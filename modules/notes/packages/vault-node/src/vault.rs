//! 库生命周期与监视事件的 Node-API 适配。

use std::{sync::Arc, time::Duration};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use nous_vault::Vault;
use crate::runtime::{lock_state, to_napi, AppState};
use crate::search;

/// 监视通知携带受影响路径及健康状态；失败不能伪装成一次成功刷新。
#[napi(object)]
pub struct JsVaultEvent {
    /// changed、watch-error 或 index-error。
    pub status: String,
    /// 已约束到当前库的相对路径，空列表表示需要完整刷新。
    pub paths: Vec<String>,
    /// 本次确实完成了监视后的索引校验。
    pub healthy: bool,
    /// 异常原因；成功事件不提供。
    pub message: Option<String>,
}

/// 打开库并开始监视。
///
/// `root` 是库目录，`index_dir` 是库外的派生索引与恢复目录。
/// 监视线程在防抖与索引刷新后，将 `on_changed` 投递给持有内核的 JS 线程。
/// 成功后替换当前库及其监视器；失败时保留原库。
///
/// # Errors
///
/// 打不开目录、索引或监视器时失败。
#[napi]
pub fn vault_open(root: String, index_dir: String, on_changed: JsFunction) -> Result<()> {
    search::cancel_current()?;
    let tsfn: ThreadsafeFunction<JsVaultEvent, ErrorStrategy::Fatal> =
        on_changed.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;
    let vault = Arc::new(Vault::open(&root, &index_dir).map_err(to_napi)?);
    // macOS 监视事件会使用 /private/var 等物理路径，比较前只规范化库根，删除事件不能再解析文件。
    let watch_root = std::fs::canonicalize(vault.root())
        .map_err(|error| Error::from_reason(error.to_string()))?;
    let watched = Arc::clone(&vault);
    let watch = nous_vault::start_watch(root, Duration::from_millis(300), move |event| {
        let notification = match event {
            Err(message) => JsVaultEvent {
                status: "watch-error".into(),
                paths: Vec::new(),
                healthy: false,
                message: Some(message),
            },
            Ok(paths) => {
                let paths = paths
                    .into_iter()
                    .filter_map(|path| {
                        path.strip_prefix(&watch_root)
                            .ok()
                            .map(nous_vault::path_to_slashes)
                    })
                    .collect::<std::result::Result<Vec<_>, _>>();
                let (paths, refreshed) = match paths {
                    Ok(paths) => (paths, watched.refresh_index()),
                    Err(error) => (Vec::new(), Err(error)),
                };
                match refreshed {
                    Ok(_) => JsVaultEvent {
                        status: "changed".into(),
                        paths,
                        healthy: true,
                        message: None,
                    },
                    Err(error) => JsVaultEvent {
                        status: "index-error".into(),
                        paths,
                        healthy: false,
                        message: Some(error.to_string()),
                    },
                }
            }
        };
        tsfn.call(notification, ThreadsafeFunctionCallMode::NonBlocking);
    })
    .map_err(to_napi)?;
    let mut state = lock_state()?;
    *state = Some(AppState {
        vault,
        _watch: watch,
        search: None,
    });
    Ok(())
}

/// 关闭当前库并停止监视。
///
/// # Errors
///
/// 锁毒化时失败。
#[napi]
pub fn vault_close() -> Result<()> {
    let mut state = lock_state()?;
    *state = None;
    Ok(())
}
