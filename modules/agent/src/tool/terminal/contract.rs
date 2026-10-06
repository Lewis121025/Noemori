use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub(super) const DEFAULT_OUTPUT: usize = 30_000;
const MIN_OUTPUT: usize = 256;
const MAX_OUTPUT: usize = 120_000;
pub(super) const BUFFER_CHARS: usize = 262_144;
pub(super) const MAX_PROCESSES: usize = 64;

// Schema 与执行前校验共享边界，调整预算时不能只改变模型所见声明。
const MAX_COMMAND_CHARS: usize = 32_768;
const MAX_WORKDIR_CHARS: usize = 8_192;
const MAX_INPUT_CHARS: usize = 16_384;
const MAX_SESSION_ID_CHARS: usize = 64;
const MAX_EXEC_WAIT_MS: u64 = 30_000;
const MAX_INTERACT_WAIT_MS: u64 = 300_000;
const MAX_TIMEOUT_MS: u64 = 86_400_000;

fn default_yield() -> u64 {
    1_000
}
fn default_output() -> usize {
    DEFAULT_OUTPUT
}

/// 一个终端入口；命令可调用文件、Git、构建和测试工具，身份由宿主会话限定。
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(extend("type" = "object"))]
pub enum TerminalInput {
    /// 启动独立 shell 命令；等待结束后进程可继续运行。
    Exec {
        /// 交给宿主配置的 POSIX shell 执行的命令，不进行字符串拼接或转义重写。
        #[schemars(length(min = 1, max = MAX_COMMAND_CHARS))]
        cmd: String,
        /// 工作目录；相对路径相对于工具的默认目录，省略时使用默认目录。
        #[schemars(length(min = 1, max = MAX_WORKDIR_CHARS))]
        workdir: Option<String>,
        /// 是否分配伪终端；交互输入必须在启动时开启，默认使用管道。
        #[serde(default)]
        tty: bool,
        /// 本次最多等待毫秒数；零立即返回，不是进程执行超时。
        #[serde(default = "default_yield")]
        #[schemars(range(min = 0, max = MAX_EXEC_WAIT_MS))]
        yield_time_ms: u64,
        /// 返回文本字符预算；截断保留开头和结尾并标记省略量。
        #[serde(default = "default_output")]
        #[schemars(range(min = MIN_OUTPUT, max = MAX_OUTPUT))]
        max_output_chars: usize,
        /// 可选命令执行时限（毫秒）；到期终止进程组，省略则持续到退出或会话关闭。
        #[schemars(range(min = 1, max = MAX_TIMEOUT_MS))]
        timeout_ms: Option<u64>,
    },
    /// 继续读取已有进程；非空输入只接受 PTY，Ctrl-C 也可中断管道进程。
    Interact {
        /// 此会话内 exec 或 list 返回的终端标识。
        #[schemars(length(min = 1, max = MAX_SESSION_ID_CHARS))]
        session_id: String,
        /// 输入字符；空字符串只读取新增输出，换行和控制字符按原样发送。
        #[serde(default)]
        #[schemars(length(max = MAX_INPUT_CHARS))]
        input: String,
        /// 本次最多等待毫秒数；零立即读取，不终止进程。
        #[serde(default = "default_yield")]
        #[schemars(range(min = 0, max = MAX_INTERACT_WAIT_MS))]
        yield_time_ms: u64,
        /// 输出字符预算，包括省略标记；与 exec 使用相同截断规则。
        #[serde(default = "default_output")]
        #[schemars(range(min = MIN_OUTPUT, max = MAX_OUTPUT))]
        max_output_chars: usize,
    },
    /// 终止进程组并回收；先发送 TERM，短暂等待后仍存活则发送 KILL。
    Stop {
        /// 此会话拥有的终端标识；已经退出的终端返回原状态。
        #[schemars(length(min = 1, max = MAX_SESSION_ID_CHARS))]
        session_id: String,
    },
    /// 列出此会话保留的终端状态，不消耗任何待返回输出。
    List,
}

#[cfg(unix)]
impl TerminalInput {
    /// 在任何进程或文件系统操作之前检查输入；宿主直接调用工具也遵守声明中的预算。
    pub(super) fn validate(&self) -> Result<(), String> {
        match self {
            Self::Exec {
                cmd,
                workdir,
                yield_time_ms,
                max_output_chars,
                timeout_ms,
                ..
            } => {
                validate_wait(*yield_time_ms, MAX_EXEC_WAIT_MS, *max_output_chars)?;
                if cmd.trim().is_empty()
                    || cmd.contains('\0')
                    || cmd.chars().count() > MAX_COMMAND_CHARS
                {
                    return Err(format!(
                        "cmd 必须非空、不包含 NUL，且不超过 {MAX_COMMAND_CHARS} 个字符"
                    ));
                }
                if timeout_ms.is_some_and(|ms| ms == 0 || ms > MAX_TIMEOUT_MS) {
                    return Err(format!("timeout_ms 必须为 1..{MAX_TIMEOUT_MS} 毫秒"));
                }
                if workdir
                    .as_ref()
                    .is_some_and(|path| path.is_empty() || path.chars().count() > MAX_WORKDIR_CHARS)
                {
                    return Err(format!(
                        "workdir 必须非空且不超过 {MAX_WORKDIR_CHARS} 个字符"
                    ));
                }
            }
            Self::Interact {
                session_id,
                input,
                yield_time_ms,
                max_output_chars,
                ..
            } => {
                validate_session_id(session_id)?;
                validate_wait(*yield_time_ms, MAX_INTERACT_WAIT_MS, *max_output_chars)?;
                if input.chars().count() > MAX_INPUT_CHARS {
                    return Err(format!("单次终端输入不能超过 {MAX_INPUT_CHARS} 个字符"));
                }
            }
            Self::Stop { session_id } => validate_session_id(session_id)?,
            Self::List => {}
        }
        Ok(())
    }
}

#[cfg(unix)]
fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.chars().count() > MAX_SESSION_ID_CHARS {
        return Err(format!(
            "session_id 必须为 1..{MAX_SESSION_ID_CHARS} 个字符"
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_wait(wait: u64, max_wait: u64, chars: usize) -> Result<(), String> {
    if wait > max_wait {
        return Err(format!("yield_time_ms 不能超过 {max_wait}"));
    }
    if !(MIN_OUTPUT..=MAX_OUTPUT).contains(&chars) {
        return Err(format!(
            "max_output_chars 必须为 {MIN_OUTPUT}..{MAX_OUTPUT}"
        ));
    }
    Ok(())
}

/// 命令生命周期；工具调用等待结束时可能仍为 running。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    /// 进程仍在运行或正在回收输出。
    Running,
    /// 命令自然退出；非零退出码同样保留为命令结果。
    Exited,
    /// 被显式停止或随会话关闭而停止。
    Stopped,
    /// 超过启动时指定的命令执行时限。
    TimedOut,
    /// 执行中发生系统或输出读取错误；error 包含原因。
    Failed,
}

/// 模型可见的进程状态；不暴露操作系统 PID、内部调用关联或追踪元数据。
#[derive(Clone, Debug, Serialize)]
pub struct TerminalInfo {
    /// 供后续 interact、stop 使用的业务定位标识。
    pub session_id: String,
    /// 当前生命周期状态。
    pub status: TerminalStatus,
    /// 正常退出码；被信号终止时省略，改由 signal 说明。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// 导致退出的 Unix 信号名称。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    /// 基础操作失败或输出不完整时的明确原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 一次读取的增量输出；同一段文本只会被一次成功的读取消耗。
#[derive(Debug, Serialize)]
pub struct TerminalObservation {
    /// 进程状态与业务标识。
    #[serde(flatten)]
    pub process: TerminalInfo,
    /// 管道 stdout/stderr 按实际读取次序合并；PTY 返回终端输出。
    pub output: String,
    /// 是否因缓冲或本次输出预算省略了文字。
    pub truncated: bool,
    /// 被省略的 Unicode 字符数；用于准确告知模型输出不完整。
    pub omitted_chars: u64,
}

/// 列表里的简短命令信息，用于上下文压缩后找回后台任务。
#[derive(Debug, Serialize)]
pub struct TerminalSummary {
    /// 进程状态。
    #[serde(flatten)]
    pub process: TerminalInfo,
    /// 命令开头，最多 256 个字符；仅用来识别任务。
    pub command: String,
    /// 启动时确定的绝对工作目录。
    pub workdir: String,
    /// 是否支持交互式标准输入。
    pub tty: bool,
}

/// 单次操作的结果，错误由注册表转成模型可见的错误观察。
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum TerminalOutput {
    /// exec、interact 或 stop 的增量观察。
    Observation(TerminalObservation),
    /// list 返回的当前会话终端集合。
    List {
        /// 运行中和已完成但尚未回收的终端，不包含其他会话的数据。
        terminals: Vec<TerminalSummary>,
    },
}

#[cfg(all(test, unix))]
#[path = "../../../../../test/agent/terminal/unit/input.rs"]
mod tests;
