use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 宿主创建、按单进程只读挂载的网关连接信息；不使用模型参数选择目标或修改规则。
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RelayConfig {
    pub(crate) gateway: PathBuf,
    pub(crate) password: String,
}
