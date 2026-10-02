//! 批量业务完全在 Rust 中执行，适配层只复制控制句柄与请求。
use crate::{
    runtime::{to_napi, NativeRuntime},
    vault::NativeControl,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
impl NativeRuntime {
    /// 执行整批请求；返回真实完成前缀，取消只能发生在事务边界。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn entry_batch(
        &self,
        env: Env,
        #[napi(ts_arg_type = "unknown")] request: serde_json::Value,
        control: &NativeControl,
    ) -> Result<Object> {
        let control = control.inner.clone();
        self.inner.register_control(&control);
        self.write(env, true, move |s| {
            s.entry_batch(request, &control).map_err(to_napi)
        })
    }
}
