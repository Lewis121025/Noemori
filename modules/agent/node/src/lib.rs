//! Node-API 只适配桌面会话协议；权限、历史闭合和进程资源留在 Agent 内核。
mod model;
use napi::{
    bindgen_prelude::*,
    threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use noemori_agent::host::{DesktopSession, DesktopSessionOptions, HostApprovalReply};
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    #[serde(default)]
    ui: Option<UiOptions>,
    #[serde(default)]
    ui_label: String,
    #[serde(default)]
    browser: Option<BrowserOptions>,
    workspace: PathBuf,
    shell: PathBuf,
    launcher: PathBuf,
    model: model::Settings,
    permission_store: Option<PathBuf>,
    #[serde(default)]
    readable_paths: Vec<PathBuf>,
    #[serde(default)]
    environment: Environment,
}

/// 运行资产和连接目录来自可信主进程，模型不能替换。
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UiOptions {
    executable: PathBuf,
    broker_directory: PathBuf,
    extension_id: String,
    computer_helper: Option<PathBuf>,
}

/// 浏览器进程、入口及显示模式由可信桌面宿主冻结，模型不能替换执行环境。
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserOptions {
    node: PathBuf,
    worker: PathBuf,
    executable: Option<PathBuf>,
    #[serde(default)]
    headless: bool,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Environment {
    #[serde(default)]
    executable_paths: Vec<PathBuf>,
    #[serde(default)]
    variables: std::collections::BTreeMap<String, String>,
}

/// 一条桌面对话的原生资源句柄；关闭 Promise 完成才表示运行和终端已回收。
#[napi]
pub struct NativeAgentSession {
    inner: DesktopSession,
}

// 构造与每轮覆盖共用预算，避免界面允许的 URL 编码扩展在续轮入口被不同上限拒绝。
const MAX_CONFIGURATION_BYTES: usize = 1024 * 1024;

#[napi]
impl NativeAgentSession {
    /// 解析宿主目录、权限与初始模型；不运行模型或 shell，通知合并为一个待交付事件。
    #[napi(constructor)]
    pub fn new(
        env: Env,
        configuration: String,
        #[napi(ts_arg_type = "() => void")] changed: JsFunction,
    ) -> Result<Self> {
        if configuration.len() > MAX_CONFIGURATION_BYTES {
            return Err(Error::from_reason("Agent 配置超过 1 MiB 预算"));
        }
        let config: Options = serde_json::from_str(&configuration).map_err(to_napi)?;
        let model = config.model.build().map_err(to_napi)?;
        let pending = Arc::new(AtomicBool::new(false));
        let delivery = pending.clone();
        let mut callback: ThreadsafeFunction<(), ErrorStrategy::Fatal> = changed
            .create_threadsafe_function(1, move |_| {
                delivery.store(false, Ordering::Release);
                Ok(Vec::<String>::new())
            })?;
        callback.unref(&env)?;
        let changed = Arc::new(move || {
            if !pending.swap(true, Ordering::AcqRel) {
                let status = callback.call((), ThreadsafeFunctionCallMode::NonBlocking);
                if status != Status::Ok {
                    pending.store(false, Ordering::Release);
                    if status != Status::Closing {
                        eprintln!("Agent 状态通知交付失败：{status:?}");
                    }
                }
            }
        });
        let mut options = DesktopSessionOptions::new(config.workspace);
        options.shell = config.shell;
        options.permission_store = config.permission_store;
        options.sandbox.launcher = Some(config.launcher);
        options.sandbox.readable_paths = config.readable_paths;
        options.sandbox.environment = noemori_agent::tool::terminal::SandboxEnvironment {
            executable_paths: config.environment.executable_paths,
            variables: config.environment.variables,
        };
        options.browser =
            config
                .browser
                .map(|browser| noemori_agent::tool::browser::BrowserConfig {
                    node: browser.node,
                    worker: browser.worker,
                    browser: browser.executable,
                    workspace: options.workspace.clone(),
                    headless: browser.headless,
                    private_origins: Vec::new(),
                });
        options.ui_label = config.ui_label;
        if let Some(ui) = config.ui {
            options.ui = Some(noemori_agent::tool::ui::UiConfig {
                executable: ui.executable,
                broker: noemori_agent::tool::ui::broker::UiBroker::open(
                    ui.broker_directory,
                    ui.extension_id,
                    changed.clone(),
                )
                .map_err(to_napi)?,
                computer_helper: ui.computer_helper,
                workspace: options.workspace.clone(),
            });
        }
        let inner = within_runtime_if_available(|| DesktopSession::new(model, options, changed))
            .map_err(to_napi)?;
        Ok(Self { inner })
    }

    /// 快照不消费输出；供应商原生签名和认证配置不包含在结果中。
    #[napi]
    pub fn snapshot(&self) -> Result<String> {
        serde_json::to_string(&self.inner.snapshot()).map_err(to_napi)
    }

    /// 读取当前会话浮窗画面；参数必须是固定目标结构，返回画面和输入凭据的 JSON 或错误。
    #[napi]
    pub async fn ui_preview(&self, target: String) -> Result<String> {
        if target.len() > 2048 { return Err(Error::from_reason("预览目标超限")); }
        let frame = self.inner.ui_preview(serde_json::from_str(&target).map_err(to_napi)?).await.map_err(to_napi)?;
        serde_json::to_string(&frame).map_err(to_napi)
    }

    /// 转发用户接管后的有界浏览器输入；无效目标或控制状态使 Promise 拒绝。
    #[napi]
    pub async fn browser_input(&self, page: String, token: String, input: String) -> Result<()> {
        if page.len() > 128 || token.is_empty() || token.len() > 128 || input.len() > 65536 { return Err(Error::from_reason("人工输入超限")); }
        self.inner.browser_input(page, token, serde_json::from_str(&input).map_err(to_napi)?).await.map_err(to_napi)
    }

    /// 可信主进程切换 UI 控制权；不会自动启动或恢复模型生成。
    /// 后端、窗口身份、运行状态或确认回执无效时拒绝 Promise。
    #[napi]
    pub async fn ui_control(&self, backend: String, resume: bool) -> Result<String> {
        serde_json::to_string(
            &self
                .inner
                .ui_control(&backend, resume)
                .await
                .map_err(to_napi)?,
        )
        .map_err(to_napi)
    }
    /// 用户明确检查时读取原生权限状态，不代替用户授权。
    #[napi]
    pub async fn ui_permissions(&self) -> Result<String> {
        serde_json::to_string(&self.inner.ui_permissions().await.map_err(to_napi)?).map_err(to_napi)
    }

    /// 中断明确的运行并等待终态；旧运行标识、超时或关闭错误会拒绝 Promise。
    #[napi]
    pub async fn interrupt(&self, run_id: String) -> Result<()> {
        self.inner.interrupt(&run_id).await.map_err(to_napi)
    }

    /// 返回仅可信主进程可持久化的闭合历史，不包含认证或可复用的进程句柄。
    #[napi]
    pub fn checkpoint(&self) -> Result<String> {
        serde_json::to_string(&self.inner.checkpoint().map_err(to_napi)?).map_err(to_napi)
    }

    /// 仅向新会话恢复相同工作区的记录；非法历史、版本不符或已使用的会话均拒绝。
    #[napi]
    pub fn restore(&self, checkpoint: String) -> Result<()> {
        if checkpoint.len() > 64 * 1024 * 1024 {
            return Err(Error::from_reason("对话记录超过 64 MiB，无法恢复"));
        }
        self.inner
            .restore(decode_checkpoint(&checkpoint)?)
            .map_err(to_napi)
    }

    /// 启动一轮任务，返回宿主运行标识；实际进度通过快照读取。
    #[napi]
    pub fn start(&self, text: String, context: Option<String>) -> Result<String> {
        match context {
            Some(context) => self.inner.start_with_context(text, context),
            None => self.inner.start(text),
        }
        .map_err(to_napi)
    }

    /// 每轮使用主进程最新模型配置，后台资源保持会话归属。
    /// configuration 为不超过 1 MiB 的模型 JSON，binding 为可信主进程计算的连接指纹。
    /// text 为本轮任务，context 为可选文章事实；返回运行标识，不自动重放旧任务。
    /// 配置、历史或上下文无效，或会话关闭、正在运行时返回错误，不修改已有运行。
    #[napi]
    pub fn start_configured(
        &self,
        configuration: String,
        binding: String,
        text: String,
        context: Option<String>,
    ) -> Result<String> {
        if configuration.len() > MAX_CONFIGURATION_BYTES {
            return Err(Error::from_reason("模型配置超过 1 MiB"));
        }
        let settings: model::Settings = serde_json::from_str(&configuration).map_err(to_napi)?;
        let model = settings.build().map_err(Error::from_reason)?;
        self.inner
            .start_configured(model, binding, text, context)
            .map_err(to_napi)
    }

    /// 取消当前运行和审批，不自动重放命令。
    /// 当前运行接收补充文字，在下一次模型请求中生效，不新建轮次。
    /// run_id 必须匹配当前运行；text 非空且至多 128 KiB；失效、停止或输入超限返回错误。
    #[napi]
    pub fn steer(&self, run_id: String, text: String) -> Result<String> {
        self.inner.steer(&run_id, text).map_err(to_napi)
    }

    /// 取消当前运行和审批，不自动重放命令。
    #[napi]
    pub fn cancel(&self) {
        self.inner.cancel();
    }

    /// 只有可信宿主可以交还人工持有的浏览器，模型工具不暴露恢复控制动作。
    /// resume 为 true 表示交还，为 false 表示接管；env 将异步回执适配为 Promise<string>。
    /// 会话关闭、运行占用、浏览器不可用或 Node-API 适配失败时拒绝 Promise 或返回错误。
    #[napi(ts_return_type = "Promise<string>")]
    pub fn browser_control(&self, env: Env, resume: bool) -> Result<Object> {
        let inner = self.inner.clone();
        env.execute_tokio_future(
            async move {
                inner
                    .browser_control(resume)
                    .await
                    .map_err(to_napi)
                    .and_then(|result| serde_json::to_string(&result).map_err(to_napi))
            },
            |_, value| Ok(value),
        )
    }

    /// 只回复当前有效且类型匹配的申请，迟到批准被拒绝。
    #[napi]
    pub fn approve(&self, id: String, decision: String) -> Result<()> {
        if decision.len() > 16384 {
            return Err(Error::from_reason("审批回复超过预算"));
        }
        let reply: HostApprovalReply = serde_json::from_str(&decision).map_err(to_napi)?;
        self.inner.resolve_approval(&id, reply).map_err(to_napi)
    }

    /// 独立读取原始终端页，偏移为整数十进制字符串，避免 JS 数字精度损失。
    #[napi(ts_return_type = "Promise<string>")]
    pub fn read_terminal(
        &self,
        env: Env,
        id: String,
        offset: String,
        limit: u32,
    ) -> Result<Object> {
        let offset = offset.parse::<u64>().map_err(to_napi)?;
        let inner = self.inner.clone();
        env.execute_tokio_future(
            async move {
                inner
                    .read_terminal(&id, offset, limit as usize)
                    .await
                    .map_err(to_napi)
                    .and_then(|page| serde_json::to_string(&page).map_err(to_napi))
            },
            |_, value| Ok(value),
        )
    }

    /// 将键盘或粘贴字节送入终端，不消费模型增量结果。
    #[napi(ts_return_type = "Promise<void>")]
    pub fn send_input(
        &self,
        env: Env,
        id: String,
        input: Buffer,
        close_stdin: bool,
    ) -> Result<Object> {
        if input.len() > 16384 {
            return Err(Error::from_reason("终端输入超过 16 KiB 预算"));
        }
        let inner = self.inner.clone();
        let bytes = input.to_vec();
        env.execute_tokio_future(
            async move {
                inner
                    .send_input(&id, &bytes, close_stdin)
                    .await
                    .map_err(to_napi)
            },
            |_, ()| Ok(()),
        )
    }

    /// 排队停止终端，退出确认通过后续快照交付。
    #[napi]
    pub fn stop_terminal(&self, id: String) -> Result<()> {
        self.inner.stop_terminal(&id).map_err(to_napi)
    }

    /// 宿主终端动作与模型调用经过同一参数和归属检查。
    #[napi(ts_return_type = "Promise<string>")]
    pub fn terminal_action(&self, env: Env, arguments: String) -> Result<Object> {
        if arguments.len() > 1024 * 1024 {
            return Err(Error::from_reason("终端动作参数超过预算"));
        }
        let arguments = serde_json::from_str(&arguments).map_err(to_napi)?;
        let inner = self.inner.clone();
        env.execute_tokio_future(
            async move {
                inner
                    .terminal_action(arguments)
                    .await
                    .map_err(to_napi)
                    .and_then(|value| serde_json::to_string(&value).map_err(to_napi))
            },
            |_, value| Ok(value),
        )
    }

    /// 永久关闭会话并等待真实停机，窗口关闭与应用退出均使用此入口。
    #[napi(ts_return_type = "Promise<void>")]
    pub fn close(&self, env: Env) -> Result<Object> {
        let inner = self.inner.clone();
        env.execute_tokio_future(
            async move { inner.close().await.map_err(to_napi) },
            |_, ()| Ok(()),
        )
    }
}
fn to_napi(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}

// 解析器会在枚举错误中回显输入；检查点含供应商私有载荷，只交付故障阶段。
fn decode_checkpoint(value: &str) -> Result<noemori_agent::host::HostCheckpoint> {
    serde_json::from_str(value).map_err(|_| Error::from_reason("对话检查点格式无效"))
}

/// 在闭合轮次之后派生历史并交付安全投影；不启动资源，原检查点保持不变。
/// checkpoint 为宿主私有 JSON，turn_id 省略时复制当前完整检查点；校验失败拒绝 Promise。
#[napi]
pub async fn branch_checkpoint(checkpoint: String, turn_id: Option<String>) -> Result<String> {
    if checkpoint.len() > 64 * 1024 * 1024 {
        return Err(Error::from_reason("对话记录超过 64 MiB，无法分叉"));
    }
    spawn_blocking(move || {
        let original = decode_checkpoint(&checkpoint)?;
        let branch = original.branch_after(turn_id.as_deref()).map_err(to_napi)?;
        let view = branch.snapshot().map_err(to_napi)?;
        serde_json::to_string(&serde_json::json!({
            "checkpoint": serde_json::to_string(&branch).map_err(to_napi)?, "snapshot": view,
        }))
        .map_err(to_napi)
    })
    .await
    .map_err(to_napi)?
}

/// 用户重新打开迁移后的笔记库时重绑静态历史；失败拒绝，不启动模型或工具。
#[napi]
pub async fn relocate_checkpoint(checkpoint: String, workspace: String) -> Result<String> {
    if checkpoint.len() > 64 * 1024 * 1024 {
        return Err(Error::from_reason("对话记录超过 64 MiB"));
    }
    spawn_blocking(move || {
        let saved = decode_checkpoint(&checkpoint)?;
        serde_json::to_string(
            &saved
                .relocate(std::path::Path::new(&workspace))
                .map_err(to_napi)?,
        )
        .map_err(to_napi)
    })
    .await
    .map_err(to_napi)?
}
