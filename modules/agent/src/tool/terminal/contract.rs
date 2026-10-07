use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub(super) const DEFAULT_OUTPUT: usize = 30_000;
const MIN_OUTPUT: usize = 256;
pub(super) const MAX_OUTPUT: usize = 120_000;
pub(super) const BUFFER_CHARS: usize = 262_144;
pub(super) const MAX_PROCESSES: usize = 64;
pub(super) const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const MAX_SESSION_LOG_BYTES: u64 = 256 * 1024 * 1024;

// Schema 与执行前校验共享边界，调整预算时不能只改变模型所见声明。
pub(super) const MAX_COMMAND_CHARS: usize = 32_768;
const MAX_WORKDIR_CHARS: usize = 8_192;
const MAX_INPUT_CHARS: usize = 16_384;
pub(super) const MAX_INPUT_BYTES: usize = 16_384;
const MAX_INPUT_BASE64: usize = MAX_INPUT_BYTES.div_ceil(3) * 4;
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

/// 以字符单元表示的 PTY 大小；有效范围为 1..=4096，避免无效尺寸进入系统调用。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TerminalSize {
    /// 行数。
    #[schemars(range(min = 1, max = 4096))]
    pub rows: u16,
    /// 列数。
    #[schemars(range(min = 1, max = 4096))]
    pub columns: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            rows: 24,
            columns: 120,
        }
    }
}

impl TerminalSize {
    pub(super) fn validate(self) -> Result<(), String> {
        if (1..=4096).contains(&self.rows) && (1..=4096).contains(&self.columns) {
            Ok(())
        } else {
            Err("终端行列数必须为 1..=4096".into())
        }
    }
}

/// 一个终端入口；命令可调用文件、Git、构建和测试工具，身份由宿主会话限定。
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(extend("type" = "object"))]
pub enum TerminalInput {
    /// 启动独立 shell 命令；等待结束后进程可继续运行。
    Exec {
        /// 作为独立参数交给宿主配置的 POSIX shell，不与初始化脚本拼接。
        #[schemars(length(min = 1, max = MAX_COMMAND_CHARS))]
        cmd: String,
        /// 是否使用登录 shell 环境；省略时由宿主默认配置决定，宿主可禁用。
        login: Option<bool>,
        /// 工作目录；相对路径相对于工具的默认目录，省略时使用默认目录。
        #[schemars(length(min = 1, max = MAX_WORKDIR_CHARS))]
        workdir: Option<String>,
        /// 是否分配伪终端；交互输入必须在启动时开启，默认使用管道。
        #[serde(default)]
        tty: bool,
        /// 非 PTY 时是否打开可写标准输入；默认关闭，PTY 自带输入。
        #[serde(default)]
        stdin: bool,
        /// 初始 PTY 尺寸；仅 tty=true 可用，省略时为 24 行、120 列。
        size: Option<TerminalSize>,
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
        /// 申请本进程所需的额外权限；必须由宿主审批，模型不能自行确认。
        #[serde(default)]
        permission_request: Option<super::approval::TerminalPermissionRequest>,
    },
    /// 继续读取已有进程；可向 PTY 或显式打开的标准输入写入，关闭的普通管道仍接受 Ctrl-C 中断。
    Interact {
        /// 此会话内 exec 或 list 返回的终端标识。
        #[schemars(length(min = 1, max = MAX_SESSION_ID_CHARS))]
        session_id: String,
        /// 输入字符；空字符串只读取新增输出，换行和控制字符按原样发送。
        #[serde(default)]
        #[schemars(length(max = MAX_INPUT_CHARS))]
        input: String,
        /// 写入 input 后关闭管道标准输入；PTY 不支持半关闭，应使用控制字符或 stop。
        #[serde(default)]
        close_stdin: bool,
        /// 本次最多等待毫秒数；零立即读取，不终止进程。
        #[serde(default = "default_yield")]
        #[schemars(range(min = 0, max = MAX_INTERACT_WAIT_MS))]
        yield_time_ms: u64,
        /// 输出字符预算，包括省略标记；与 exec 使用相同截断规则。
        #[serde(default = "default_output")]
        #[schemars(range(min = MIN_OUTPUT, max = MAX_OUTPUT))]
        max_output_chars: usize,
    },
    /// 无损写入任意标准输入字节；使用标准 Base64，避免 JSON 字符串的 UTF-8 限制。
    Write {
        /// 此会话拥有且在启动时开启输入的终端标识。
        #[schemars(length(min = 1, max = MAX_SESSION_ID_CHARS))]
        session_id: String,
        /// 标准 Base64 字节，解码后最多 16 KiB；空串可用于仅发送 EOF。
        #[serde(default)]
        #[schemars(length(max = MAX_INPUT_BASE64))]
        data_base64: String,
        /// 写入后关闭管道输入；PTY 不支持半关闭。
        #[serde(default)]
        close_stdin: bool,
        /// 等待输出的时间，与 interact 相同。
        #[serde(default = "default_yield")]
        #[schemars(range(min = 0, max = MAX_INTERACT_WAIT_MS))]
        yield_time_ms: u64,
        /// 返回文本预览的字符预算。
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
    /// 按 UTF-8 字节游标重复读取已保存的日志，不消耗 interact 的增量输出。
    Read {
        /// 此会话拥有的终端标识；命令结束后仍可读取，直到记录被释放或会话关闭。
        #[schemars(length(min = 1, max = MAX_SESSION_ID_CHARS))]
        session_id: String,
        /// 从零开始的 UTF-8 字节位置；续读使用上次返回的 next_offset。
        #[serde(default)]
        offset: u64,
        /// 此页最多返回的 Unicode 字符数，元数据不计入正文预算。
        #[serde(default = "default_output")]
        #[schemars(range(min = MIN_OUTPUT, max = MAX_OUTPUT))]
        max_output_chars: usize,
    },
    /// 按原始字节游标读取带流来源的日志；字节可在任意位置分页，不经过文本解码。
    ReadBytes {
        /// 此会话拥有的终端标识。
        #[schemars(length(min = 1, max = MAX_SESSION_ID_CHARS))]
        session_id: String,
        /// stdout/stderr 实际提交顺序中的累计原始字节位置，独立于 read 的文本游标。
        #[serde(default)]
        offset: u64,
        /// 本页原始字节预算；Base64 编码和元数据不计入该预算。
        #[serde(default = "default_output")]
        #[schemars(range(min = 1, max = MAX_OUTPUT))]
        max_output_bytes: usize,
    },
    /// 释放已结束的终端记录及日志；运行中的进程必须先 stop。
    Release {
        /// 此会话拥有且已结束的终端标识。
        #[schemars(length(min = 1, max = MAX_SESSION_ID_CHARS))]
        session_id: String,
    },
    /// 调整已有 PTY 的行列数；不会消耗输出或向普通管道注入字节。
    Resize {
        /// 此会话拥有的运行中 PTY 标识。
        #[schemars(length(min = 1, max = MAX_SESSION_ID_CHARS))]
        session_id: String,
        /// 新的字符单元尺寸。
        size: TerminalSize,
    },
    /// 向进程发送 SIGINT；与给普通管道写入字节 0x03 区分。
    Interrupt {
        /// 此会话拥有的运行中终端标识。
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
                permission_request,
                tty,
                size,
                ..
            } => {
                validate_wait(*yield_time_ms, MAX_EXEC_WAIT_MS, *max_output_chars)?;
                if let Some(size) = size {
                    if !tty {
                        return Err("仅 PTY 可以指定终端尺寸".into());
                    }
                    size.validate()?;
                }
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
                if let Some(request) = permission_request {
                    if request.reason.trim().is_empty() || request.reason.chars().count() > 2048 {
                        return Err("权限申请必须提供 1..2048 个字符的明确原因".into());
                    }
                    if request.readable_paths.len() + request.writable_paths.len() > 64 {
                        return Err("一次权限申请最多包含 64 个路径".into());
                    }
                    if request.readable_paths.is_empty()
                        && request.writable_paths.is_empty()
                        && !request.network
                    {
                        return Err("权限申请没有请求任何额外权限".into());
                    }
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
            Self::Write {
                session_id,
                data_base64,
                yield_time_ms,
                max_output_chars,
                ..
            } => {
                validate_session_id(session_id)?;
                validate_wait(*yield_time_ms, MAX_INTERACT_WAIT_MS, *max_output_chars)?;
                decode_input(data_base64)?;
            }
            Self::Stop { session_id }
            | Self::Release { session_id }
            | Self::Interrupt { session_id } => validate_session_id(session_id)?,
            Self::Resize { session_id, size } => {
                validate_session_id(session_id)?;
                size.validate()?;
            }
            Self::Read {
                session_id,
                max_output_chars,
                ..
            } => {
                validate_session_id(session_id)?;
                validate_wait(0, 0, *max_output_chars)?;
            }
            Self::ReadBytes {
                session_id,
                max_output_bytes,
                ..
            } => {
                validate_session_id(session_id)?;
                if !(1..=MAX_OUTPUT).contains(max_output_bytes) {
                    return Err(format!("max_output_bytes 必须为 1..={MAX_OUTPUT}"));
                }
            }
            Self::List => {}
        }
        Ok(())
    }
}

#[cfg(unix)]
pub(super) fn decode_input(encoded: &str) -> Result<Vec<u8>, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    if encoded.len() > MAX_INPUT_BASE64 {
        return Err("单次原始输入不能超过 16 KiB".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "data_base64 必须是标准 Base64")?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("单次原始输入不能超过 16 KiB".into());
    }
    Ok(bytes)
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

/// 可重复读取的日志页；游标属于调用者，读取不会改变其他读者或增量观察的位置。
#[derive(Debug, Serialize)]
pub struct TerminalOutputPage {
    /// 读取时的进程状态；running 表示后续仍可能产生输出。
    #[serde(flatten)]
    pub process: TerminalInfo,
    /// 本页正文，始终在 UTF-8 字符边界结束。
    pub output: String,
    /// 本页起始字节位置。
    pub offset: u64,
    /// 下一页起始字节位置；没有新内容时保持不变。
    pub next_offset: u64,
    /// 此次读取快照的日志总字节数，不代表运行中命令的最终长度。
    pub total_bytes: u64,
    /// 当前快照中是否还有尚未返回的内容。
    pub has_more: bool,
}

/// 原始输出的来源；PTY 的内核接口天然合并两种标准流，不能恢复独立 stderr。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStream {
    /// 非 PTY 的标准输出。
    Stdout,
    /// 非 PTY 的标准错误输出。
    Stderr,
    /// PTY 主设备输出，包括终端回显与控制序列。
    Terminal,
}

/// 无损输出分片；只保证同一流的顺序，跨流顺序为读取任务提交日志的顺序。
#[derive(Clone, Debug, Serialize)]
pub struct TerminalOutputChunk {
    /// 分片来自的输出流。
    pub stream: TerminalStream,
    /// 原始字节的标准 Base64，不经过 UTF-8 解码或 ANSI 过滤。
    pub data_base64: String,
    /// 本分片在合并原始字节序列中的起点。
    pub offset: u64,
    /// 本分片结束位置，可作为下一次订阅或 read_bytes 的游标。
    pub next_offset: u64,
}

/// 原始输出日志页；多个读者分别持有游标，读取不会消耗文本预览。
#[derive(Debug, Serialize)]
pub struct TerminalBytesPage {
    /// 当前进程状态；终态只在全部输出提交后发布。
    #[serde(flatten)]
    pub process: TerminalInfo,
    /// 带流来源的原始字节分片，单页最多 256 个以限制元数据开销。
    pub chunks: Vec<TerminalOutputChunk>,
    /// 此次请求的原始字节起点。
    pub offset: u64,
    /// 下一次读取的原始字节起点。
    pub next_offset: u64,
    /// 读取快照中的原始输出字节总数。
    pub total_bytes: u64,
    /// 该快照中是否还有未返回的原始字节。
    pub has_more: bool,
}

/// 宿主实时接收的终端事件；退出事件唯一且位于全部输出事件之后。
#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum TerminalEvent {
    /// 一段可按游标回放的原始输出。
    Output {
        /// 事件所属终端。
        session_id: String,
        /// 本次输出及续读游标。
        #[serde(flatten)]
        chunk: TerminalOutputChunk,
    },
    /// 输出已收尾，之后该订阅不再产生事件。
    Exited {
        /// 终态、退出码与可能的基础设施错误。
        #[serde(flatten)]
        process: TerminalInfo,
    },
}

/// 宿主配置的日志磁盘预算；预算包含编码记录的全部字节，None 表示不设软件上限。
#[derive(Clone, Copy, Debug)]
pub struct TerminalLogLimits {
    /// 单个进程的日志容量；达到限制明确终止，不静默覆盖旧输出。
    pub process_bytes: Option<u64>,
    /// 会话中所有保留日志的容量；释放记录后归还，独立于单进程预算。
    pub session_bytes: Option<u64>,
}

impl Default for TerminalLogLimits {
    fn default() -> Self {
        Self {
            process_bytes: Some(MAX_LOG_BYTES),
            session_bytes: Some(MAX_SESSION_LOG_BYTES),
        }
    }
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
    /// 此次快照中是否仍可写入标准输入；PTY 与显式打开的管道均可能为 true。
    pub stdin_open: bool,
}

/// 单次操作的结果，错误由注册表转成模型可见的错误观察。
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum TerminalOutput {
    /// exec、interact 或 stop 的增量观察。
    Observation(TerminalObservation),
    /// read 返回的非消费式日志页。
    Page(TerminalOutputPage),
    /// read_bytes 返回的无损分流日志页。
    Bytes(TerminalBytesPage),
    /// release 成功后此标识不可再次读取；已经开始的读取结束后回收文件和日志配额。
    Released {
        /// 已释放的终端标识。
        session_id: String,
        /// 成功时固定为 true，失败由工具错误表达。
        released: bool,
    },
    /// resize 或 interrupt 已被持有进程句柄的后台任务执行。
    Controlled {
        /// 操作对应的终端标识。
        session_id: String,
        /// 成功时为 true；系统调用失败仍返回工具错误。
        applied: bool,
    },
    /// list 返回的当前会话终端集合。
    List {
        /// 运行中和已完成但尚未回收的终端，不包含其他会话的数据。
        terminals: Vec<TerminalSummary>,
    },
}

#[cfg(all(test, unix))]
#[path = "../../../../../test/agent/terminal/unit/input.rs"]
mod tests;
