use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const FRAME_LIMIT: usize = 1024 * 1024;

/// 宿主到执行进程的闭合消息；回复不能注入新的脚本或改变资源归属。
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum GuestInput {
    Run {
        id: String,
        code: String,
        timeout_ms: u64,
    },
    Reset {
        id: String,
    },
    Reply {
        id: u64,
        value: Value,
    },
}

/// 执行进程只请求已登记 SDK 能力；外部动作的真实回执由宿主保存。
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum GuestOutput {
    Call { id: u64, request: Value },
    Finished(GuestFinished),
}

/// 单个脚本的终态；显式保存重置事实，避免把解释器崩溃当作变量仍可复用。
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GuestFinished {
    pub id: String,
    pub prints: Vec<Value>,
    pub images: Vec<String>,
    pub error: Option<String>,
    pub reset: bool,
}
