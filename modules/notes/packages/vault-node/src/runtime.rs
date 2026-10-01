//! 所有绑定共享唯一库状态，避免不同入口在切库时持有不同归属。

use std::sync::{Arc, Mutex};
use napi::bindgen_prelude::*;
use noemori_vault::{Vault, WatchHandle};
use crate::entry_batch;

/// 当前库及其后台资源；切库与关闭统一通过此状态释放旧查询和监视器。
pub(crate) struct AppState {
    pub(crate) vault: Arc<Vault>,
    pub(crate) _watch: WatchHandle,
    pub(crate) search: Option<(String, noemori_vault::SearchCancellation)>,
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Some((_, token)) = &self.search {
            token.cancel();
        }
    }
}

static STATE: Mutex<Option<AppState>> = Mutex::new(None);

/// 将内核错误保留为 JavaScript 异常原因。
pub(crate) fn to_napi(err: noemori_vault::Error) -> Error {
    Error::from_reason(err.to_string())
}

/// 在加锁前拒绝回调重入；锁毒化时返回错误。
pub(crate) fn lock_state() -> Result<std::sync::MutexGuard<'static, Option<AppState>>> {
    entry_batch::check_callback_reentry()?;
    STATE
        .lock()
        .map_err(|_| Error::from_reason("内核状态锁已毒化"))
}

/// 在整个内核调用期间持有状态锁，切库不能使正在执行的操作失去归属。
pub(crate) fn with_vault<T>(
    operation: impl FnOnce(&Vault) -> std::result::Result<T, noemori_vault::Error>,
) -> Result<T> {
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    operation(&state.vault).map_err(to_napi)
}
