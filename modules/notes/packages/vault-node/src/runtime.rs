//! Node 环境仅拥有运行时句柄；每次调用同步入队，异步交付最终结果。

use crate::{vault::JsVaultEvent, watch_events::PendingNotification};
use napi::{
    bindgen_prelude::*,
    threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use noemori_runtime::{Pending, Runtime, State};
use noemori_vault::Vault;
use std::sync::{Arc, Mutex};

/// 一个宿主的 Rust 运行时；显式 shutdown 负责等待磁盘任务与监听退出。
#[napi]
pub struct NativeRuntime {
    pub(crate) inner: Arc<Runtime>,
}

#[napi]
impl NativeRuntime {
    /// 创建轻量句柄；初始化不读取磁盘，首个应用命令在后台执行。
    #[napi(constructor)]
    pub fn new(
        user_data: String,
        #[napi(ts_arg_type = "(event: JsVaultEvent) => void")] on_changed: JsFunction,
    ) -> Result<Self> {
        let pending = Arc::new(Mutex::new(PendingNotification::default()));
        let delivery = Arc::clone(&pending);
        let tsfn: ThreadsafeFunction<(), ErrorStrategy::Fatal> = on_changed
            .create_threadsafe_function(1, move |_| {
                let event = delivery
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                    .ok_or_else(|| Error::from_reason("缺少待交付的监视通知"))?;
                Ok(vec![JsVaultEvent {
                    generation: event.generation.to_string(),
                    status: event.status,
                    paths: event.paths,
                    healthy: event.healthy,
                    message: event.message,
                }])
            })?;
        let runtime = within_runtime_if_available(|| {
            Runtime::new(user_data.into(), move |event| {
                if pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(event)
                {
                    tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
                }
            })
        });
        Ok(Self {
            inner: Arc::new(runtime),
        })
    }

    /// 当前代次只访问原子内存，供宿主丢弃迟到事件。
    #[napi(getter)]
    pub fn generation(&self) -> String {
        self.inner.generation().to_string()
    }

    /// 关闭入口并排空所有已接受任务；Promise 完成才表示监听已停止。
    #[napi(ts_return_type = "Promise<void>")]
    pub fn shutdown(&self, env: Env) -> Result<Object> {
        let stopped = self.inner.shutdown();
        env.execute_tokio_future(
            async move { stopped.await.map_err(to_napi) },
            |_, ()| Ok(()),
        )
    }
}

/// 保留业务错误原因，不把未知结果自动重试成第二次写入。
pub(crate) fn to_napi(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}

/// 复用原始 DTO 转换，库实例由调度器显式绑定，转换层不持有全局状态锁。
pub(crate) fn with_vault<T>(
    vault: &Vault,
    operation: impl FnOnce(&Vault) -> std::result::Result<T, noemori_vault::Error>,
) -> Result<T> {
    operation(vault).map_err(to_napi)
}

impl NativeRuntime {
    pub(crate) fn deliver<T: Send + ToNapiValue + 'static>(
        &self,
        env: Env,
        pending: Pending<Result<T>>,
        generation: Option<u64>,
    ) -> Result<Object> {
        let runtime = Arc::clone(&self.inner);
        env.execute_tokio_future(
            async move { pending.wait().await.map_err(to_napi)? },
            move |_, result| {
                if generation.is_some_and(|g| g != runtime.generation()) {
                    return Err(Error::from_reason("笔记库已切换，请重试"));
                }
                Ok(result)
            },
        )
    }

    pub(crate) fn read<T: Send + ToNapiValue + 'static>(
        &self,
        env: Env,
        operation: impl FnOnce(&Vault) -> Result<T> + Send + 'static,
    ) -> Result<Object> {
        let generation = self.inner.generation();
        let pending = self.inner.read(move |vault| operation(&vault));
        self.deliver(env, pending, Some(generation))
    }

    pub(crate) fn write<T: Send + ToNapiValue + 'static>(
        &self,
        env: Env,
        scoped: bool,
        operation: impl FnOnce(&mut State) -> Result<T> + Send + 'static,
    ) -> Result<Object> {
        let pending = self.inner.write(scoped, operation);
        self.deliver(env, pending, None)
    }
}
