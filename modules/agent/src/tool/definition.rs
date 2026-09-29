use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 供模型理解的纯数据声明；Schema 同时用于真实执行前的参数校验。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// 1–64 位 ASCII 字母、数字、下划线或连字符，在同一注册表中唯一。
    pub name: String,
    /// 供模型选择工具时读取的用途与调用前置条件。
    pub description: String,
    /// 根类型明确为 object 的 JSON Schema，引用必须在声明内部闭合。
    pub input_schema: Value,
}

impl ToolDefinition {
    /// 校验工具声明，保证直接模型调用和注册执行遵守同一名称与参数契约。
    ///
    /// # 返回
    /// 合法声明返回 `Ok(())`，不会执行工具或访问外部 Schema。
    ///
    /// # 错误
    /// 名称不合法、根 Schema 未声明对象类型或 Schema 无效时返回配置错误。
    pub fn validate(&self) -> Result<(), Error> {
        self.compile().map(|_| ())
    }

    pub(crate) fn compile(&self) -> Result<jsonschema::Validator, Error> {
        if self.name.is_empty()
            || self.name.len() > 64
            || !self
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(Error::Config(
                "工具名称必须为 1–64 位字母、数字、下划线或连字符".into(),
            ));
        }
        if self.input_schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(Error::Config("工具参数 Schema 必须为对象类型".into()));
        }
        jsonschema::options()
            .offline()
            .build(&self.input_schema)
            .map_err(|error| Error::Config(format!("工具 Schema 无效：{error}")))
    }
}
