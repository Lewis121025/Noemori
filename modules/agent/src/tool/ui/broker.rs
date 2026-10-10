//! 应用级本地连接所有者；浏览器标签页与会话配对由可信扩展 UI 提供。
use super::wire;
use crate::ExecutionContext;
#[cfg(unix)]
mod artifacts;
#[cfg(unix)]
mod connection;
mod contract;
mod lifecycle;
mod native;
pub use contract::{ConnectionConfig, UiConnection, UiReceipt, UiRpcError};
pub use native::run_native_bridge;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::oneshot;

/// 只有完整落盘后才登记下载；临时路径的所有权随会话资源一起释放。
struct Artifact {
    session: String,
    backend: String,
    page: String,
    name: String,
    bytes: u64,
    path: tempfile::TempPath,
}
#[cfg(unix)]
use std::{
    io::Write,
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
};

/// 取消等待只移走 sender，迟到回执仍更新原动作；连接或会话终止才回收记录。
struct Pending {
    session: String,
    action: String,
    sender: Option<oneshot::Sender<Result<Value, UiRpcError>>>,
}
#[cfg(unix)]
/// 已认证连接集中拥有未结算动作，共享页与人工接管状态分别绑定会话。
struct Port {
    stream: Arc<Mutex<UnixStream>>,
    view: UiConnection,
    shares: BTreeMap<String, Vec<Value>>,
    human: std::collections::BTreeSet<String>,
    pending: BTreeMap<String, Pending>,
}
#[derive(Default)]
/// sessions 只列出可派发的会话；关闭后的资源可以继续结算到释放回执到达。
struct State {
    sessions: BTreeMap<String, String>,
    #[cfg(unix)]
    ports: BTreeMap<String, Port>,
    closed: bool,
    receipts: BTreeMap<String, Vec<UiReceipt>>,
    artifacts: BTreeMap<String, Artifact>,
    saving: BTreeMap<String, String>,
    ui_locks: std::collections::BTreeSet<String>,
    browser_epoch: u64,
}
/// 应用级连接所有者，弱通知回调不会因共用 broker 而保活已关闭对话。
struct Inner {
    state: Mutex<State>,
    config: ConnectionConfig,
    directory: PathBuf,
    observers: Mutex<Vec<Weak<dyn Fn() + Send + Sync>>>,
    launch: tokio::sync::Mutex<()>,
    #[cfg(unix)]
    _socket_directory: tempfile::TempDir,
}

/// 多对话共享一个 broker；本地权限与连接配对在此集中维护。
#[derive(Clone)]
pub struct UiBroker {
    inner: Arc<Inner>,
    _observer: Arc<dyn Fn() + Send + Sync>,
}
fn changes_ui(action: &str) -> bool {
    matches!(
        action,
        "open"
            | "navigate"
            | "back"
            | "forward"
            | "reload"
            | "close"
            | "find"
            | "fill"
            | "select"
            | "check"
            | "click"
            | "hover"
            | "pointer"
            | "drag"
            | "press"
            | "type"
            | "key"
            | "scroll"
            | "dialog"
            | "upload"
            | "choose_files"
            | "upload_bytes"
            | "choose_files_bytes"
            | "batch"
            | "ax_action"
            | "set_value"
            | "locator"
            | "select_text"
            | "paste"
            | "launch_app"
            | "webmcp_invoke"
            | "grant_control"
    )
}
impl Inner {
    fn invalidate_related(&self, backend: &str, bundle: Option<&str>) {
        #[cfg(unix)]
        {
            let browser_input = backend != "computer";
            let native_browser = backend == "computer"
                && bundle.is_none_or(|bundle| {
                    matches!(
                        bundle,
                        "com.google.Chrome" | "com.microsoft.edgemac" | "org.chromium.Chromium"
                    )
                });
            let streams = {
                let mut state = self.state.lock().expect("UI broker 状态锁被污染");
                if native_browser {
                    state.browser_epoch = state.browser_epoch.wrapping_add(1);
                }
                state
                    .ports
                    .values()
                    .filter(|port| {
                        port.view.connected
                            && ((browser_input && port.view.backend == "computer")
                                || (native_browser && port.view.backend != "computer"))
                    })
                    .map(|port| port.stream.clone())
                    .collect::<Vec<_>>()
            };
            for stream in streams {
                let _ = wire::write_message(
                    &mut *stream.lock().expect("UI 写入锁被污染"),
                    &json!({"type":"invalidate","session":"*","scope":if browser_input{"browsers"}else{"all"}}),
                );
            }
        }
        #[cfg(not(unix))]
        let _ = (backend, bundle);
    }
    fn notify(&self) {
        let callbacks = {
            let mut observers = self.observers.lock().expect("UI 通知锁被污染");
            let callbacks: Vec<_> = observers.iter().filter_map(Weak::upgrade).collect();
            observers.retain(|observer| observer.strong_count() > 0);
            callbacks
        };
        for callback in callbacks {
            callback();
        }
    }
}
static BROKERS: Mutex<BTreeMap<PathBuf, Weak<Inner>>> = Mutex::new(BTreeMap::new());
impl UiBroker {
    /// 在宿主选择的目录创建私有连接；已有同目录 broker 时复用。
    /// 非 Unix、目录或 socket/文件权限失败时返回错误，不建立公开网络端点。
    pub fn open(
        directory: PathBuf,
        extension_id: String,
        changed: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        #[cfg(not(unix))]
        {
            let _ = (directory, extension_id, changed);
            Err("UI 本地 broker 暂不支持此平台".into())
        }
        #[cfg(unix)]
        {
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let directory = directory.canonicalize().map_err(|e| e.to_string())?;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            let mut brokers = BROKERS.lock().expect("UI broker 目录锁被污染");
            if let Some(inner) = brokers.get(&directory).and_then(Weak::upgrade) {
                if inner.config.extension_id != extension_id {
                    return Err("同一 broker 不能替换扩展身份".into());
                }
                inner
                    .observers
                    .lock()
                    .expect("UI 通知锁被污染")
                    .push(Arc::downgrade(&changed));
                return Ok(Self {
                    inner,
                    _observer: changed,
                });
            }
            let socket_directory = tempfile::Builder::new()
                .prefix("nui-")
                .tempdir()
                .map_err(|e| e.to_string())?;
            let socket = socket_directory.path().join("s");
            let listener = UnixListener::bind(&socket).map_err(|e| e.to_string())?;
            fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
            let config = ConnectionConfig {
                socket,
                token: uuid::Uuid::new_v4().to_string(),
                extension_id,
            };
            let path = directory.join("connection.json");
            let mut file =
                tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
            file.write_all(&serde_json::to_vec(&config).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            file.persist(path).map_err(|e| e.to_string())?;
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let inner = Arc::new(Inner {
                state: Mutex::new(State::default()),
                config,
                directory: directory.clone(),
                observers: Mutex::new(vec![Arc::downgrade(&changed)]),
                launch: tokio::sync::Mutex::new(()),
                _socket_directory: socket_directory,
            });
            brokers.insert(directory, Arc::downgrade(&inner));
            let weak = Arc::downgrade(&inner);
            std::thread::spawn(move || {
                loop {
                    let Some(owner) = weak.upgrade() else {
                        break;
                    };
                    if owner.state.lock().expect("UI broker 状态锁被污染").closed {
                        break;
                    }
                    drop(owner);
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let weak = weak.clone();
                            std::thread::spawn(move || {
                                let _ = connection::serve(stream, weak);
                            });
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(20))
                        }
                        Err(_) => break,
                    }
                }
            });
            Ok(Self {
                inner,
                _observer: changed,
            })
        }
    }
    /// 登记宿主会话，供扩展 UI 明确选择；模型不能伪造会话归属。
    pub fn register(&self, session: &str, label: &str) {
        self.inner
            .state
            .lock()
            .expect("UI broker 状态锁被污染")
            .sessions
            .insert(session.into(), label.into());
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
    pub(crate) fn browser_epoch(&self) -> u64 {
        self.inner
            .state
            .lock()
            .expect("UI broker 状态锁被污染")
            .browser_epoch
    }
    pub(crate) fn paused(&self, session: &str, backend: &str) -> bool {
        #[cfg(unix)]
        {
            self.inner
                .state
                .lock()
                .expect("UI broker 状态锁被污染")
                .ports
                .values()
                .filter(|port| port.view.backend == backend && port.view.connected)
                .any(|port| port.view.human || port.human.contains(session))
        }
        #[cfg(not(unix))]
        {
            let _ = (session, backend);
            true
        }
    }
    pub(crate) fn notify_effect(&self, backend: &str, action: &str, value: &Value) {
        if !matches!(
            value.get("outcome").and_then(Value::as_str),
            Some("executed" | "unknown")
        ) || !changes_ui(action)
        {
            return;
        }
        self.inner
            .invalidate_related(backend, value.get("bundle_id").and_then(Value::as_str));
    }
    /// 获取本会话的有界回执，包括脚本取消后才收到的后端结算。
    pub fn receipts(&self, session: &str) -> Vec<UiReceipt> {
        self.inner
            .state
            .lock()
            .expect("UI broker 状态锁被污染")
            .receipts
            .get(session)
            .cloned()
            .unwrap_or_default()
    }
    /// 返回当前会话已完整落盘的受管下载，不泄露其他会话的文件或私有路径。
    pub fn downloads(&self, session: &str, backend: &str) -> Vec<Value> {
        self.inner.state.lock().expect("UI broker 状态锁被污染").artifacts.iter().filter(|(_,file)|file.session==session && file.backend==backend).map(|(id,file)|json!({"id":id,"name":file.name,"page":file.page,"bytes":file.bytes,"status":"completed","error":null})).collect()
    }
    pub(crate) fn artifact(&self, session: &str, id: &str) -> Result<PathBuf, String> {
        self.inner
            .state
            .lock()
            .expect("UI broker 状态锁被污染")
            .artifacts
            .get(id)
            .filter(|file| file.session == session)
            .map(|file| file.path.to_path_buf())
            .ok_or_else(|| "下载不存在或不属于当前会话".into())
    }
    /// 读取本会话的已配对连接；不暴露未共享的标签页信息。
    pub fn connections(&self, session: &str) -> Vec<UiConnection> {
        #[cfg(not(unix))]
        {
            let _ = session;
            vec![]
        }
        #[cfg(unix)]
        {
            self.inner
                .state
                .lock()
                .expect("UI broker 状态锁被污染")
                .ports
                .values()
                .filter_map(|port| {
                    let tabs = if port.view.backend == "computer" {
                        vec![]
                    } else {
                        port.shares.get(session)?.clone()
                    };
                    Some(UiConnection {
                        tabs,
                        human: port.view.human || port.human.contains(session),
                        ..port.view.clone()
                    })
                })
                .collect()
        }
    }
    /// 请求已配对后端的动作；取消通知仍发送给后端，未确认动作不能自动重试。
    pub async fn execute(
        &self,
        session: &str,
        backend: &str,
        action: Value,
        context: &ExecutionContext,
    ) -> Result<Value, UiRpcError> {
        #[cfg(not(unix))]
        {
            let _ = (session, backend, action, context);
            Err(UiRpcError::NotExecuted("UI broker 不支持此平台".into()))
        }
        #[cfg(unix)]
        {
            context
                .check()
                .map_err(|e| UiRpcError::NotExecuted(e.to_string()))?;
            let id = uuid::Uuid::new_v4().to_string();
            let (sender, receiver) = oneshot::channel();
            let (connection, stream) = {
                let mut state = self.inner.state.lock().expect("UI broker 状态锁被污染");
                if !state.sessions.contains_key(session) {
                    return Err(UiRpcError::NotExecuted("UI 会话已关闭或未登记".into()));
                }
                if backend == "computer"
                    && !state.ui_locks.is_empty()
                    && !matches!(
                        action.get("action").and_then(Value::as_str),
                        Some(
                            "permissions"
                                | "apps"
                                | "windows"
                                | "observe"
                                | "screenshot"
                                | "preview"
                                | "control_state"
                                | "invalidate"
                        )
                    )
                {
                    return Err(UiRpcError::NotExecuted(
                        "授权界面由用户操作，原生输入已经暂停".into(),
                    ));
                }
                let candidates: Vec<_> = state
                    .ports
                    .iter()
                    .filter(|(_, p)| {
                        p.view.backend == backend
                            && p.view.connected
                            && (backend == "computer" || p.shares.contains_key(session))
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                if candidates.len() != 1 {
                    return Err(UiRpcError::NotExecuted(
                        if candidates.is_empty() {
                            "请在扩展中连接 Noemori 并共享当前会话的标签页"
                        } else {
                            "同一浏览器有多个共享连接，请在扩展中取消多余共享"
                        }
                        .into(),
                    ));
                }
                let connection = candidates[0].clone();
                let port = state.ports.get_mut(&connection).expect("连接存在");
                if (port.view.human || port.human.contains(session))
                    && !matches!(
                        action.get("action").and_then(Value::as_str),
                        Some(
                            "resume"
                                | "grant_control"
                                | "control_state"
                                | "tabs"
                                | "preview"
                                | "permissions"
                                | "human_input"
                                | "apps"
                                | "windows"
                        )
                    )
                {
                    return Err(UiRpcError::NotExecuted(
                        "用户持有控制权，只能由可信界面交还".into(),
                    ));
                }
                let action_name = action
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if port.pending.len() >= 256 {
                    return Err(UiRpcError::NotExecuted("连接未结算动作达到上限".into()));
                }
                port.pending.insert(
                    id.clone(),
                    Pending {
                        session: session.into(),
                        action: action_name.clone(),
                        sender: Some(sender),
                    },
                );
                let stream = port.stream.clone();
                if action_name != "preview" {
                    let receipts = state.receipts.entry(session.into()).or_default();
                    receipts.push(UiReceipt {
                        id: id.clone(),
                        backend: backend.into(),
                        action: action_name,
                        outcome: "unknown".into(),
                        pending: true,
                        error: None,
                    });
                    if receipts.len() > 256 {
                        receipts.remove(0);
                    }
                }
                (connection, stream)
            };
            let remaining = context
                .deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_millis();
            let epoch = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| UiRpcError::NotExecuted(e.to_string()))?
                .as_millis();
            let frame = json!({"type":"call","version":1,"id":id,"session":session,"action":action,"timeout_ms":remaining,"expires_at":epoch+remaining});
            if let Err(error) =
                wire::write_message(&mut *stream.lock().expect("UI 写入锁被污染"), &frame)
            {
                self.cancel_pending(&connection, &id);
                return Err(UiRpcError::Unknown(error));
            }
            match context.wait(receiver).await {
                Ok(result) => {
                    result.map_err(|_| UiRpcError::Unknown("UI 后端回执通道关闭".into()))?
                }
                Err(error) => {
                    let _ = wire::write_message(
                        &mut *stream.lock().expect("UI 写入锁被污染"),
                        &json!({"type":"cancel","id":id,"session":session}),
                    );
                    self.cancel_pending(&connection, &id);
                    Err(UiRpcError::Unknown(format!(
                        "{error}；已派发动作的结果需要重新观察"
                    )))
                }
            }
        }
    }
    #[cfg(unix)]
    fn cancel_pending(&self, connection: &str, id: &str) {
        if let Some(pending) = self
            .inner
            .state
            .lock()
            .expect("UI broker 状态锁被污染")
            .ports
            .get_mut(connection)
            .and_then(|port| port.pending.get_mut(id))
        {
            pending.sender = None;
        }
    }
    /// 返回只供可信启动器使用的定位文件，模型工具不会返回此路径。
    pub fn configuration_path(&self) -> PathBuf {
        self.inner.directory.join("connection.json")
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Ok(state) = self.state.get_mut() {
            state.closed = true;
            for port in state.ports.values() {
                if let Ok(stream) = port.stream.lock() {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
            }
        }
        let _ = fs::remove_file(&self.config.socket);
        let path = self.directory.join("connection.json");
        if fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ConnectionConfig>(&bytes).ok())
            .is_some_and(|config| config.token == self.config.token)
        {
            let _ = fs::remove_file(path);
        }
    }
}
