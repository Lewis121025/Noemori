//! 开库与会话只适配 Rust 运行时，不再通过同步 JavaScript 回调提交。
use crate::runtime::{to_napi, NativeRuntime};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// 内存控制句柄，取消和进度不排在正在执行的操作之后。
#[napi]
pub struct NativeControl {
    pub(crate) inner: noemori_runtime::OperationControl,
}

#[napi]
impl NativeControl {
    /// 创建可取消操作；磁盘工作由持有句柄的命令负责。
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: noemori_runtime::OperationControl::default(),
        }
    }
    /// 原子请求取消；已经提交的操作返回 false。
    #[napi]
    pub fn cancel(&self) -> bool {
        self.inner.cancel()
    }
    /// 读取取消标记，目录对话框结束后仍能识别此前的取消。
    #[napi(getter)]
    pub fn cancelled(&self) -> bool {
        self.inner.cancelled()
    }
    /// 当前阶段完整快照，不等待任何磁盘任务。
    #[napi(getter, ts_return_type = "unknown")]
    pub fn progress(&self) -> Result<serde_json::Value> {
        serde_json::to_value(self.inner.progress()).map_err(to_napi)
    }
}
impl Default for NativeControl {
    fn default() -> Self {
        Self::new()
    }
}

/// 监视事件携带代次，主线程交付时过滤已关闭的库。
#[napi(object)]
pub struct JsVaultEvent {
    /// 原生运行时代次；不暴露给渲染进程。
    pub generation: String,
    /// changed、watch-error 或 index-error。
    pub status: String,
    /// 受影响的库内路径；空表示完整刷新。
    pub paths: Vec<String>,
    /// 是否完成索引复核。
    pub healthy: bool,
    /// 失败时保留原因。
    pub message: Option<String>,
}

#[napi]
impl NativeRuntime {
    /// 启动固定应用仓库；旧单目录会话以副本接入，草稿与阅读路径由 Rust 迁移。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn vault_library_restore(&self, env: Env, root: String, control: &NativeControl) -> Result<Object> {
        let control = control.inner.clone();
        self.inner.register_control(&control);
        self.write(env, false, move |state| state.restore_library(&root, &control).map_err(to_napi))
    }

    /// 在当前仓库的指定父目录导入完整副本；取消返回 null，错误或警告保留提交边界。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn directory_import(&self, env: Env, root: String, source: String, parent: String, control: &NativeControl) -> Result<Object> {
        let control = control.inner.clone();
        self.inner.register_control(&control);
        self.write(env, true, move |state| state.import_directory(&root, &source, &parent, &control).map_err(to_napi))
    }

    /// 准备候选库并原子切换；取消返回 null，失败保留旧库。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn vault_open(&self, env: Env, root: String, control: &NativeControl) -> Result<Object> {
        let control = control.inner.clone();
        self.inner.register_control(&control);
        self.write(env, false, move |state| {
            state.open(&root, false, &control).map_err(to_napi)
        })
    }
    /// 在后台创建默认目录并打开，主线程只负责提供系统路径。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn vault_create(&self, env: Env, root: String, control: &NativeControl) -> Result<Object> {
        let control = control.inner.clone();
        self.inner.register_control(&control);
        self.write(env, false, move |state| {
            state.create(&root, &control).map_err(to_napi)
        })
    }

    /// 从磁盘会话恢复原库与阅读现场；失败不覆盖原会话。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn vault_restore(&self, env: Env, control: &NativeControl) -> Result<Object> {
        let control = control.inner.clone();
        self.inner.register_control(&control);
        self.write(env, false, move |state| {
            state.restore(&control).map_err(to_napi)
        })
    }
    /// 顺序关闭当前库，等待监视线程退出。
    #[napi(ts_return_type = "Promise<void>")]
    pub fn vault_close(&self, env: Env) -> Result<Object> {
        self.write(env, false, |s| s.close().map_err(to_napi))
    }
    /// 读取兼容旧格式的应用会话；磁盘错误按现有恢复规则回退。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn session_load(&self, env: Env) -> Result<Object> {
        self.write(env, false, |s| Ok(s.sessions.load()))
    }
    /// 仅替换应用字段；输入由主进程校验，Rust 仍归一化磁盘格式。
    #[napi(ts_return_type = "Promise<void>")]
    pub fn session_patch(
        &self,
        env: Env,
        #[napi(ts_arg_type = "unknown")] patch: serde_json::Value,
    ) -> Result<Object> {
        self.write(env, false, move |s| {
            s.sessions.patch(&patch).map_err(to_napi)
        })
    }
    /// 合并阅读器会话，不允许覆盖窗口和外观字段。
    #[napi(ts_return_type = "Promise<void>")]
    pub fn reader_session_patch(
        &self,
        env: Env,
        #[napi(ts_arg_type = "unknown")] patch: serde_json::Value,
    ) -> Result<Object> {
        self.write(env, true, move |s| {
            s.sessions.patch_reader(&patch).map_err(to_napi)
        })
    }
    /// 目录状态绑定库根，迟到的旧状态不能覆盖新库。
    #[napi(ts_return_type = "Promise<void>")]
    pub fn reader_file_tree_save(
        &self,
        env: Env,
        root: String,
        #[napi(ts_arg_type = "unknown")] tree: serde_json::Value,
    ) -> Result<Object> {
        self.write(env, true, move |s| {
            s.require_root(&root).map_err(to_napi)?;
            s.sessions
                .patch_reader(&serde_json::json!({"fileTree": tree}))
                .map_err(to_napi)
        })
    }
}
