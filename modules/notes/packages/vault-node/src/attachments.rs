//! 附件字节导入与提交警告的 Node-API 适配。

use crate::runtime::{to_napi, NativeRuntime};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// 独占导入的附件位置和提交后警告。
#[napi(object)]
pub struct JsImportedAttachment {
    /// 实际库内路径，同名避让后可能与原文件名不同。
    pub path: String,
    /// 文件已落盘后发生的索引或同步错误。
    pub warning: Option<String>,
}

#[napi]
impl NativeRuntime {
    /// 导入用户选择的附件字节，返回实际位置；路径、大小与写盘错误由内核传播。
    #[napi(ts_return_type = "Promise<JsImportedAttachment>")]
    pub fn attachment_import(
        &self,
        env: Env,
        root: String,
        from: String,
        name: String,
        bytes: Buffer,
    ) -> Result<Object> {
        let bytes = bytes.to_vec();
        self.write(env, true, move |state| {
            let result = state
                .import_attachment(&root, &from, &name, &bytes)
                .map_err(to_napi)?;
            Ok(JsImportedAttachment {
                path: result.path,
                warning: result.warning,
            })
        })
    }
}
