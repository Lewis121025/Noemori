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
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
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

#[napi]
impl NativeAgentSession {
    /// 解析宿主提供的冻结配置；不运行模型或 shell，通知合并为一个待交付状态变化。
    #[napi(constructor)]
    pub fn new(
        env: Env,
        configuration: String,
        #[napi(ts_arg_type = "() => void")] changed: JsFunction,
    ) -> Result<Self> {
        if configuration.len() > 1024 * 1024 {
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
        let inner = within_runtime_if_available(|| DesktopSession::new(model, options, changed))
            .map_err(to_napi)?;
        Ok(Self { inner })
    }

    /// 快照不消费输出；供应商原生签名和认证配置不包含在结果中。
    #[napi]
    pub fn snapshot(&self) -> Result<String> {
        serde_json::to_string(&self.inner.snapshot()).map_err(to_napi)
    }

    /// 启动一轮任务，返回宿主运行标识；实际进度通过快照读取。
    #[napi]
    pub fn start(&self, text: String) -> Result<String> {
        self.inner.start(text).map_err(to_napi)
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
