//! 附件字节导入与提交警告的 Node-API 适配。

use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::runtime::with_vault;

/// 独占导入的附件位置和提交后警告。
#[napi(object)]
pub struct JsImportedAttachment {
    /// 实际库内路径，同名避让后可能与原文件名不同。
    pub path: String,
    /// 文件已落盘后发生的索引或同步错误。
    pub warning: Option<String>,
}

/// 导入用户选择的附件字节，返回实际位置；路径、大小与写盘错误由内核传播。
#[napi]
pub fn attachment_import(
    from: String,
    name: String,
    bytes: Buffer,
) -> Result<JsImportedAttachment> {
    let result = with_vault(|vault| vault.import_attachment(&from, &name, bytes.as_ref()))?;
    Ok(JsImportedAttachment {
        path: result.path,
        warning: result.warning,
    })
}
