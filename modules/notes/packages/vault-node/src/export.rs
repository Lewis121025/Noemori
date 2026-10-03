//! 导出原生桥接只接受宿主动作；任务与字节持久化由运行时拥有。
use crate::{
    runtime::{to_napi, NativeRuntime},
    vault::NativeControl,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
impl NativeRuntime {
    /// 启动时核实未确认的导出结果，不自动重放原来的生成或覆盖操作。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn export_recover(&self, env: Env) -> Result<Object> {
        self.write(env, false, |state| state.export_recover().map_err(to_napi))
    }

    /// 保存门禁后准备导出；控制句柄不经过磁盘任务队列。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn export_prepare(
        &self,
        env: Env,
        root: String,
        id: String,
        paths: Option<Vec<String>>,
        hidden: bool,
        control: &NativeControl,
    ) -> Result<Object> {
        let control = control.inner.clone();
        self.inner.register_control(&control);
        self.write(env, true, move |state| {
            state
                .export_prepare(&root, id, paths, hidden, control)
                .map_err(to_napi)
        })
    }

    /// 原生校验动作和路径；动作不会作为通用文件系统能力暴露给页面。
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn export_action(
        &self,
        env: Env,
        id: String,
        action: serde_json::Value,
        bytes: Option<Buffer>,
    ) -> Result<Object> {
        let bytes = bytes.map_or_else(Vec::new, |bytes| bytes.to_vec());
        // 提交返回值不得因后续切库被降为结果未知；任务内部先核验库身份。
        self.write(env, false, move |state| {
            state.export_action(&id, action, &bytes).map_err(to_napi)
        })
    }
}
