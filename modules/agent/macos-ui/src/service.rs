//! 原生资源与控制权状态机；句柄按进程启动身份和实际 AX 对象归属。
use super::{
    ax::{self, Bounds, Element},
    input, observation, screen,
    clipboard::{self, ClipboardTransaction, PasteContent},
    text_selection::{self, TextSelection},
    pending_paste::{NativePendingPaste, NativePasteTarget, TextInteraction},
    paste_lifecycle::PasteSettlement,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{NSApplication, NSPasteboard, NSRunningApplication, NSWorkspace};
use objc2_core_foundation::CGPoint;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// 应用身份绑定启动实例，保留对象与 AX 代理不会因 PID 被复用而自动重绑定。
struct App {
    id: String,
    pid: i32,
    bundle: String,
    launch: f64,
    native: Retained<NSRunningApplication>,
    root: Element,
}
/// 窗口保存实际 AX 对象；标题和范围只作为观察信息，不用于猜测窗口句柄。
struct Window {
    app: String,
    element: Element,
    title: String,
    bounds: Bounds,
}
/// 控件引用绑定真实对象和业务语义，防止虚拟行复用同一 AX 节点。
struct Reference {
    element: Element,
    fingerprint: String,
}
/// 同一会话内每个窗口分别保存代次与截图映射，窗口变化后不能复用旧定位。
struct Observation {
    id: String,
    window: String,
    refs: BTreeMap<String, Reference>,
    bounds: Bounds,
    screenshot: Option<WindowCapture>,
    /// 只用于编码精确基线的完整证据；新观察仍重新采集真实 AX 树。
    snapshot: Value,
}
/// 像素映射和窗口编号来自同一次截图，禁止出现只更新其中一项的状态。
struct WindowCapture {
    pixels: super::geometry::PixelMapping,
    window_id: u32,
}
/// 后台授权只属于一个会话和窗口；用户切换到目标应用时暂停，避免争用。
#[derive(Clone)]
struct Lease {
    session: String,
    window: String,
    app: String,
}

/// 人工画面独立保存像素映射和随机凭据，不覆盖模型观察或授予模型控制权。
struct HumanFrame {
    app: String,
    observation: Observation,
}

/// 主线程拥有的原生服务；只接收已认证 broker 的命令，不接受任意系统指针。
pub struct Service {
    apps: BTreeMap<String, App>,
    windows: BTreeMap<String, Window>,
    observations: BTreeMap<(String, String), Observation>,
    lease: Option<Lease>,
    protected: Vec<i32>,
    paused: BTreeSet<String>,
    approved: BTreeMap<String, Lease>,
    human_frames: BTreeMap<String, HumanFrame>,
    pending_paste: Option<NativePendingPaste>,
    clipboard_settlement: Option<Value>,
}
impl Service {
    /// 创建当前主线程的原生资源所有者；protected 是可信宿主与 helper 的进程身份。
    /// 非主线程调用返回错误，不请求或自动批准 OS 权限。
    pub fn new(protected: Vec<i32>) -> Result<Self, String> {
        let main = MainThreadMarker::new().ok_or("原生服务必须在主线程创建")?;
        // Helper 是后台 macOS 应用；先建立 AppKit 的 WindowServer 连接，截图回调不能负责首次初始化。
        let _application = NSApplication::sharedApplication(main);
        Ok(Self {
            apps: Default::default(),
            windows: Default::default(),
            observations: Default::default(),
            lease: None,
            protected,
            paused: Default::default(),
            approved: Default::default(),
            human_frames: Default::default(),
            pending_paste: None,
            clipboard_settlement: None,
        })
    }
    fn update_control(&mut self) {
        input::pump();
        if self
            .lease
            .as_ref()
            .is_some_and(|lease| self.check_lease(lease).is_err())
        {
            if let Some(lease) = self.lease.take() {
                self.paused.insert(lease.session);
            }
            self.observations.clear();
        }
    }
    /// 检查目标应用是否被用户接管，只返回实际暂停的会话。
    pub fn poll(&mut self) -> Vec<String> {
        self.poll_clipboard();
        self.update_control();
        std::mem::take(&mut self.paused).into_iter().collect()
    }
    /// 释放会话控制权和观察，不关闭用户应用；关闭连接时必须调用。
    pub fn release(&mut self, session: &str) {
        if let Some(pending) = &mut self.pending_paste
            && (session == "*" || pending.session() == session)
        {
            pending.interrupted("会话已释放，等待已投递粘贴的安全清理".into());
        }
        if session == "*" {
            self.observations.clear();
            self.lease = None;
            self.approved.clear();
            self.human_frames.clear();
        } else {
            self.approved.remove(session);
            self.human_frames.remove(session);
            self.observations.retain(|(owner, _), _| owner != session);
            if self
                .lease
                .as_ref()
                .is_some_and(|lease| lease.session == session)
            {
                self.lease = None;
            }
        }
    }
    /// 关联浏览器操作仅撤销相关窗口观察；控制权仍由明确的人工租约决定。
    pub fn invalidate(&mut self, browsers_only: bool) {
        self.observations.retain(|(_, window), _| {
            browsers_only
                && self
                    .windows
                    .get(window)
                    .and_then(|window| self.apps.get(&window.app))
                    .is_some_and(|app| {
                        !matches!(
                            app.bundle.as_str(),
                            "com.google.Chrome" | "com.microsoft.edgemac" | "org.chromium.Chromium"
                        )
                    })
        });
    }
    /// 执行宿主认证后的动作；失败返回真实阶段，已派发的输入不能声称未执行。
    pub fn execute(&mut self, session: &str, action: Value, cancel: Arc<AtomicBool>) -> Value {
        let mut dispatched = false;
        let result = self.perform(session, &action, &cancel, &mut dispatched);
        let mut output = match result {
            Ok(value) => value,
            Err(error) => {
                if dispatched
                    && let Some(window) = action.get("window").and_then(Value::as_str)
                {
                    self.observations.remove(&(session.into(), window.into()));
                }
                json!({"outcome":if dispatched{"unknown"}else{"not_executed"},"error":error,"mode":"background"})
            }
        };
        if output["outcome"] == "unknown"
            && let Some(window) = action.get("window").and_then(Value::as_str)
        {
            self.observations.remove(&(session.into(), window.into()));
        }
        if let Some(bundle) = action
            .get("window")
            .and_then(Value::as_str)
            .and_then(|window| self.windows.get(window))
            .and_then(|window| self.apps.get(&window.app))
            .map(|app| &app.bundle)
        {
            output["bundle_id"] = json!(bundle);
        }
        self.clipboard_state(&mut output);
        output
    }
    /// 断连后的排空也只调用此方法；存在事务时保留原材料，直到三种安全条件之一成立。
    pub fn poll_clipboard(&mut self) -> bool {
        input::pump();
        if let Some(pending) = &mut self.pending_paste {
            match pending.poll() {
                Ok(Some(settled)) => {
                    self.clipboard_settlement = Some(Self::settlement_value(&settled));
                    self.pending_paste = None;
                }
                Ok(None) => {}
                Err(error) => {
                    self.clipboard_settlement =
                        Some(json!({"token":pending.token(),"status":"pending","error":error}));
                }
            }
        }
        self.pending_paste.is_some()
    }
    fn settlement_value(settled: &PasteSettlement) -> Value {
        json!({"token":settled.token,"status":"settled","reason":settled.reason.name(),"acknowledged":settled.acknowledged,"clipboard_restored":settled.clipboard_restored,"interrupted":settled.interrupted,"error":settled.error})
    }
    fn clipboard_state(&self, output: &mut Value) {
        let foreign = if self.pending_paste.is_none() { clipboard::shared_pending_token() } else { None };
        output["clipboard_pending"] = json!(self.pending_paste.is_some() || foreign.is_some());
        if let Some(pending) = &self.pending_paste {
            output["clipboard_token"] = json!(pending.token());
            if let Some(error) = pending.error() {
                output["clipboard_error"] = json!(error);
            }
        }
        if let Some(settled) = &self.clipboard_settlement {
            output["clipboard_settlement"] = settled.clone();
        }
        if let Some(token) = foreign {
            if token != "unrecognized" { output["clipboard_token"] = json!(token); }
            output["clipboard_error"] = json!("另一 Helper 持有尚未安全结算的剪贴板事务，请等待原事务或用户覆盖；本 Helper 不接管其材料");
        }
    }
    fn update_apps(&mut self) -> Result<Value, String> {
        let native = NSWorkspace::sharedWorkspace().runningApplications();
        let mut output = Vec::new();
        let mut live = std::collections::BTreeSet::new();
        for app in native.iter() {
            let pid = app.processIdentifier();
            // 枚举保留对象可能已在退出过程中失去 PID；失效实体不能进入运行身份和 AX 缓存。
            if app.isTerminated()
                || pid <= 0
                || self.protected.contains(&pid)
                || pid == std::process::id() as i32
            {
                continue;
            }
            let bundle = app
                .bundleIdentifier()
                .map(|v| v.to_string())
                .unwrap_or_default();
            if bundle.starts_with("app.noemori.") || bundle == "com.apple.SecurityAgent" {
                continue;
            }
            let launch = app
                .launchDate()
                .map(|v| v.timeIntervalSince1970())
                .unwrap_or(0.0);
            let id = format!("{pid}:{launch:.6}");
            live.insert(id.clone());
            let name = app
                .localizedName()
                .map(|v| v.to_string())
                .unwrap_or_default();
            if !self.apps.contains_key(&id) {
                self.apps.insert(
                    id.clone(),
                    App {
                        id: id.clone(),
                        pid,
                        bundle: bundle.clone(),
                        launch,
                        native: app.clone(),
                        root: ax::application(pid)?,
                    },
                );
            }
            output.push(
                json!({"id":id,"pid":pid,"bundle_id":bundle,"name":name,"active":app.isActive()}),
            );
        }
        self.apps.retain(|id, _| live.contains(id));
        self.windows.retain(|_, window| live.contains(&window.app));
        self.observations
            .retain(|(_, window), _| self.windows.contains_key(window));
        Ok(json!({"outcome":"observed","apps":output}))
    }
    fn app_id(&mut self, name: &str) -> Result<String, String> {
        self.update_apps()?;
        if self.apps.contains_key(name) {
            self.validate_app(name)?;
            return Ok(name.into());
        }
        let matches: Vec<_> = self
            .apps
            .values()
            .filter(|app| app.bundle == name && !app.native.isTerminated())
            .map(|app| app.id.clone())
            .collect();
        if matches.len() != 1 {
            return Err("应用不存在或匹配多个实例，请使用 apps 返回的实际身份".into());
        }
        Ok(matches[0].clone())
    }
    fn validate_app(&self, id: &str) -> Result<&App, String> {
        let app = self.apps.get(id).ok_or("应用句柄不属于当前服务")?;
        if app.native.isTerminated()
            || app.native.processIdentifier() != app.pid
            || app
                .native
                .launchDate()
                .map(|v| v.timeIntervalSince1970())
                .unwrap_or(0.0)
                != app.launch
        {
            return Err("应用实例已经退出，禁止复用 PID".into());
        }
        Ok(app)
    }
    fn list_windows(&mut self, app: &str) -> Result<Value, String> {
        if !ax::trusted() {
            return Err("请在系统设置授予 Noemori Computer Helper 辅助功能权限".into());
        }
        let app = self.app_id(app)?;
        let roots = self.validate_app(&app)?.root.elements("AXWindows", 64)?;
        let mut output = Vec::new();
        let mut live = std::collections::BTreeSet::new();
        for element in roots {
            let existing = self
                .windows
                .iter()
                .find(|(_, window)| window.app == app && window.element.same(&element))
                .map(|(id, _)| id.clone());
            let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let bounds = element.bounds()?;
            let title = element.optional_text("AXTitle")?.unwrap_or_default();
            live.insert(id.clone());
            self.windows.insert(
                id.clone(),
                Window {
                    app: app.clone(),
                    element,
                    title: title.clone(),
                    bounds,
                },
            );
            output.push(json!({"id":id,"title":title,"bounds":bounds.json()}));
        }
        self.windows
            .retain(|id, window| window.app != app || live.contains(id));
        self.observations
            .retain(|(_, window), _| self.windows.contains_key(window));
        Ok(json!({"outcome":"observed","app":app,"windows":output}))
    }
    fn target(&self, action: &Value) -> Result<(String, String), String> {
        let window = field(action, "window")?.to_owned();
        let entry = self
            .windows
            .get(&window)
            .ok_or("窗口句柄不存在，请重新 windows")?;
        let app = self.validate_app(&entry.app)?;
        let requested = field(action, "app")?;
        if requested != app.id && requested != app.bundle {
            return Err("窗口不属于请求的应用实例".into());
        }
        let live = app.root.elements("AXWindows", 64)?;
        if !live.iter().any(|element| element.same(&entry.element)) {
            return Err("窗口已经关闭或重建".into());
        }
        Ok((entry.app.clone(), window))
    }
    fn observe(&mut self, session: &str, window: &str) -> Result<Value, String> {
        let entry = self.windows.get_mut(window).ok_or("窗口不存在")?;
        entry.bounds = entry.element.bounds()?;
        entry.title = entry.element.optional_text("AXTitle")?.unwrap_or_default();
        let deadline = Instant::now() + Duration::from_secs(2);
        let (mut nodes, mut warnings) = ax::collect(&entry.element, deadline);
        match self.apps[&entry.app].root.element("AXMenuBar") {
            Ok(menu) => {
                let (menu_nodes, menu_warnings) = ax::collect(&menu, deadline);
                nodes.extend(menu_nodes);
                warnings.extend(menu_warnings);
            }
            Err(error) => warnings.push(format!("菜单栏不可读取：{error}")),
        }
        let key = (session.into(), window.into());
        if self.observations.len() >= 256 && !self.observations.contains_key(&key) {
            return Err("原生窗口观察达到会话总数量预算，请释放不用的会话".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut refs = BTreeMap::new();
        let mut elements = Vec::new();
        for (index, (element, mut node, fingerprint)) in nodes.into_iter().enumerate() {
            let reference = format!("e{index}");
            node["ref"] = json!(reference);
            elements.push(node);
            refs.insert(
                reference,
                Reference {
                    element,
                    fingerprint,
                },
            );
        }
        let observation = json!({"id":id,"window":window,"title":entry.title,"bounds":entry.bounds.json(),"elements":elements,"warnings":warnings,"truncated":!warnings.is_empty()});
        self.observations.insert(
            key,
            Observation {
                id,
                window: window.into(),
                refs,
                bounds: entry.bounds,
                screenshot: None,
                snapshot: observation.clone(),
            },
        );
        Ok(
            json!({"outcome":"observed","observation":observation,"bundle_id":self.apps[&entry.app].bundle,"mode":"background"}),
        )
    }
    fn observe_requested(
        &mut self,
        session: &str,
        window: &str,
        mode: &str,
        baseline: Option<&str>,
    ) -> Result<Value, String> {
        let previous = self
            .observations
            .get(&(session.into(), window.into()))
            .map(|observation| observation.snapshot.clone());
        let mut result = self.observe(session, window)?;
        let encoded =
            observation::result(previous.as_ref(), &result["observation"], mode, baseline)?;
        let output = result.as_object_mut().ok_or("原生观察结果格式无效")?;
        output.remove("observation");
        output.extend(
            encoded
                .as_object()
                .ok_or("原生观察更新格式无效")?
                .clone(),
        );
        Ok(result)
    }
    fn current(&self, session: &str, action: &Value) -> Result<&Observation, String> {
        let observation = self
            .observations
            .get(&(session.into(), field(action, "window")?.into()))
            .ok_or("观察已经失效，请重新 observe")?;
        if observation.id != field(action, "observation")?
            || observation.window != field(action, "window")?
        {
            return Err("观察不属于当前窗口或已经失效".into());
        }
        let bounds = self.windows[&observation.window].element.bounds()?;
        if bounds != observation.bounds {
            return Err("窗口位置或尺寸变化，请重新截图".into());
        }
        Ok(observation)
    }
    fn check_lease(&self, lease: &Lease) -> Result<(), String> {
        if !ax::trusted() || !input::permitted() {
            return Err("后台输入权限尚未授予或已撤销".into());
        }
        let app = self.validate_app(&lease.app)?;
        self.require_background(app)?;
        let window = self
            .windows
            .get(&lease.window)
            .ok_or("已授权窗口已经关闭")?;
        if !app
            .root
            .elements("AXWindows", 64)?
            .iter()
            .any(|element| element.same(&window.element))
        {
            return Err("已授权窗口已经关闭".into());
        }
        Ok(())
    }
    fn require_background(&self, app: &App) -> Result<(), String> {
        if NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .is_some_and(|front| front.processIdentifier() == app.pid)
        {
            return Err("用户正在使用目标应用，后台操作已暂停；请切换到其他应用后交还控制".into());
        }
        Ok(())
    }
    fn background(&self, session: &str, window: &str, cancel: &AtomicBool) -> Result<(), String> {
        if cancel.load(Ordering::Acquire) {
            return Err("原生操作已取消".into());
        }
        let lease = self
            .lease
            .as_ref()
            .filter(|lease| lease.session == session && lease.window == window)
            .ok_or("当前窗口未获人工授予后台控制")?;
        self.check_lease(lease)
    }
    fn perform(
        &mut self,
        session: &str,
        action: &Value,
        cancel: &AtomicBool,
        dispatched: &mut bool,
    ) -> Result<Value, String> {
        if cancel.load(Ordering::Acquire) {
            return Err("原生操作已取消".into());
        }
        self.update_control();
        let name = field(action, "action")?;
        self.poll_clipboard();
        if (self.pending_paste.is_some() || clipboard::shared_pending_token().is_some())
            && !matches!(name, "permissions" | "apps" | "windows" | "observe" | "screenshot" | "preview" | "control_state" | "handoff" | "invalidate" | "grant_control" | "launch_info")
        {
            return Err("先前粘贴尚未确认消费或安全恢复，请查询 clipboard_pending；未派发新输入".into());
        }
        match name {
            "permissions" => {
                return Ok(
                    json!({"outcome":"observed","accessibility":ax::trusted(),"screen_recording":screen::permitted(),"input_monitoring":input::monitoring_permitted()}),
                );
            }
            "apps" => return self.update_apps(),
            "launch_info" => return super::launch::info(field(action, "bundle_id")?),
            "launch_app" => return super::launch::launch(field(action, "bundle_id")?, cancel, dispatched),
            "windows" => return self.list_windows(field(action, "app")?),
            "handoff" | "invalidate" => {
                self.observations.retain(|(owner, _), _| owner != session);
                self.human_frames.remove(session);
                if self
                    .lease
                    .as_ref()
                    .is_some_and(|lease| lease.session == session)
                {
                    self.lease = None;
                }
                return Ok(json!({"outcome":"executed","mode":"human"}));
            }
            _ => {}
        }
        let (app, window) = self.target(action)?;
        if self.apps[&app].bundle == "com.apple.systempreferences"
            && !matches!(name, "observe" | "screenshot" | "preview" | "control_state")
        {
            return Err("系统权限设置必须由用户操作，模型不能为自己授予权限".into());
        }
        if name == "control_state" {
            return Ok(
                json!({"outcome":"observed","granted":self.background(session,&window,cancel).is_ok(),"app_name":self.apps[&app].native.localizedName().map(|v|v.to_string()).unwrap_or_else(||self.apps[&app].bundle.clone()),"window_title":self.windows[&window].title}),
            );
        }
        if name == "preview" {
            return self.preview(session, &app, &window, cancel);
        }
        if name == "human_input" {
            self.human_input(session, &app, &window, action, cancel, dispatched)?;
            return Ok(json!({"outcome":"executed","mode":"human"}));
        }
        if name == "observe" {
            return self.observe_requested(
                session,
                &window,
                action.get("mode").and_then(Value::as_str).unwrap_or("full"),
                action.get("baseline").and_then(Value::as_str),
            );
        }
        if name == "grant_control" {
            return self.grant_control(session, app, window);
        }
        if name == "screenshot" {
            return self.capture_window(session, &app, &window, cancel);
        }
        let text_result = if matches!(name, "select_text" | "paste") {
            match self.perform_text(session, &app, &window, action, cancel, dispatched)? {
                TextInteraction::Completed(value) => Some(value),
                TextInteraction::Settled(settled) => {
                    let value = Self::settlement_value(&settled);
                    self.clipboard_settlement = Some(value.clone());
                    if !settled.acknowledged {
                        return Ok(json!({"outcome":"unknown","error":"粘贴消费未确认，剪贴板事务已按安全条件结束，禁止重放","text_interaction":value}));
                    }
                    Some(value)
                }
                TextInteraction::Pending(pending) => {
                    let token = pending.token().to_owned();
                    self.pending_paste = Some(pending);
                    return Ok(json!({"outcome":"unknown","error":"粘贴已投递但尚未确认消费，原剪贴板已保留等待安全恢复，禁止重放","clipboard_pending":true,"clipboard_token":token}));
                }
            }
        } else {
        if matches!(name, "ax_action" | "set_value") {
            if self.perform_ax(session, action, dispatched)? {
                return Ok(
                    json!({"outcome":"executed","mode":"human","error":"目标应用改变了焦点，后台操作已暂停"}),
                );
            }
        } else {
            self.perform_input(session, &app, &window, action, cancel, dispatched)?;
        }
        None
        };
        let policy = action
            .get("observation_mode")
            .and_then(Value::as_str)
            .unwrap_or("full");
        if policy == "none" {
            self.observations.remove(&(session.into(), window));
            return Ok(json!({"outcome":"executed","mode":"background","text_interaction":text_result}));
        }
        let mut result = self.observe_requested(
            session,
            &window,
            policy,
            action.get("observation").and_then(Value::as_str),
        )?;
        result["outcome"] = json!("executed");
        if let Some(value) = text_result { result["text_interaction"] = value; }
        Ok(result)
    }
    fn grant_control(
        &mut self,
        session: &str,
        app: String,
        window: String,
    ) -> Result<Value, String> {
        if self
            .lease
            .as_ref()
            .is_some_and(|lease| lease.session != session)
        {
            return Err("另一会话正在使用后台控制".into());
        }
        let lease = Lease {
            session: session.into(),
            window: window.clone(),
            app,
        };
        self.check_lease(&lease)?;
        self.approved.insert(session.into(), lease.clone());
        self.human_frames.remove(session);
        self.lease = Some(lease);
        let mut result = self.observe(session, &window)?;
        result["outcome"] = json!("executed");
        Ok(result)
    }
    fn preview(
        &mut self,
        session: &str,
        app: &str,
        window: &str,
        cancel: &AtomicBool,
    ) -> Result<Value, String> {
        let entry = &self.windows[window];
        let image = screen::capture(
            self.apps[app].pid,
            entry.element.window_number()?,
            entry.element.bounds()?,
            || cancel.load(Ordering::Acquire),
        )?;
        if entry.element.bounds()? != image.bounds {
            return Err("截图期间窗口位置或尺寸变化，请等待新画面".into());
        }
        let mut result = json!({"outcome":"observed", "image_data":STANDARD.encode(image.bytes), "image_format":"jpeg"});
        if self.lease.is_none()
            && self
                .approved
                .get(session)
                .is_some_and(|lease| lease.app == app && lease.window == window)
        {
            let current = entry.element.bounds()?;
            let token = self
                .human_frames
                .get(session)
                .filter(|frame| {
                    frame.app == app
                        && frame.observation.window == window
                        && frame.observation.bounds == current
                        && frame
                            .observation
                            .screenshot
                            .as_ref()
                            .is_some_and(|capture| {
                                capture.window_id == image.window_id
                                    && capture.pixels.bounds == image.bounds
                                    && capture.pixels.width == image.width
                                    && capture.pixels.height == image.height
                            })
                })
                .map(|frame| frame.observation.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            self.human_frames.insert(
                session.into(),
                HumanFrame {
                    app: app.into(),
                    observation: Observation {
                        id: token.clone(),
                        window: window.into(),
                        refs: BTreeMap::new(),
                        bounds: current,
                        screenshot: Some(WindowCapture {
                            pixels: super::geometry::PixelMapping {
                                bounds: image.bounds,
                                width: image.width,
                                height: image.height,
                            },
                            window_id: image.window_id,
                        }),
                        snapshot: Value::Null,
                    },
                },
            );
            result["input_token"] = json!(token);
        }
        Ok(result)
    }

    /// 人工输入沿用此前明确批准的窗口；图像凭据、窗口映射与控制者须同时有效。
    fn human_input(
        &self,
        session: &str,
        app: &str,
        window: &str,
        action: &Value,
        cancel: &AtomicBool,
        dispatched: &mut bool,
    ) -> Result<(), String> {
        if self.lease.is_some() {
            return Err("请先接管应用，再从画面操作".into());
        }
        let approved = self
            .approved
            .get(session)
            .filter(|lease| lease.app == app && lease.window == window)
            .ok_or("此窗口尚未获得本会话的人工批准")?;
        let token = field(action, "token")?;
        let frame = self
            .human_frames
            .get(session)
            .filter(|frame| {
                frame.app == app
                    && frame.observation.window == window
                    && frame.observation.id == token
            })
            .ok_or("画面或窗口已经变化，请等待新画面后操作")?;
        let input = action
            .get("input")
            .and_then(Value::as_object)
            .ok_or("人工输入必须为对象")?;
        let kind = input
            .get("type")
            .and_then(Value::as_str)
            .ok_or("人工输入缺少类型")?;
        let name = match kind {
            "text" => "type",
            "pointer" => "pointer_event",
            "drag" | "key" | "scroll" => kind,
            _ => return Err("原生人工输入类型无效".into()),
        };
        let mut command = Value::Object(input.clone());
        command["action"] = json!(name);
        if matches!(name, "type" | "key")
            && field(&command, if name == "type" { "text" } else { "key" })?.len()
                > if name == "type" { 65536 } else { 100 }
        {
            return Err("原生人工输入超限".into());
        }
        let check = || {
            if cancel.load(Ordering::Acquire) {
                return Err("人工输入已取消".into());
            }
            self.check_lease(approved)?;
            self.check_input_frame(app, window, name, frame.observation.bounds)
        };
        check()?;
        self.input_window(app, &command, &frame.observation, check, dispatched)
    }
    fn capture_window(
        &mut self,
        session: &str,
        app: &str,
        window: &str,
        cancel: &AtomicBool,
    ) -> Result<Value, String> {
        let mut result = self.observe(session, window)?;
        let entry = &self.windows[window];
        let screen::Captured {
            bytes,
            width,
            height,
            window_id: cg_window,
            bounds: capture_bounds,
        } = screen::capture(
            self.apps[app].pid,
            entry.element.window_number()?,
            entry.bounds,
            || cancel.load(Ordering::Acquire),
        )?;
        if entry.element.bounds()? != capture_bounds {
            return Err("截图期间窗口位置或尺寸变化，请重新观察".into());
        }
        let observation = self
            .observations
            .get_mut(&(session.into(), window.to_owned()))
            .expect("观察已登记");
        observation.screenshot = Some(WindowCapture {
            window_id: cg_window,
            pixels: super::geometry::PixelMapping {
                bounds: capture_bounds,
                width,
                height,
            },
        });
        result["image_data"] = json!(STANDARD.encode(bytes));
        result["image_format"] = json!("jpeg");
        result["mapping"] = json!({"width":width,"height":height,"screen_bounds":capture_bounds.json(),"window_id":cg_window,"scale_x":width as f64/capture_bounds.width,"scale_y":height as f64/capture_bounds.height,"crop_origin":{"x":0,"y":0}});
        Ok(result)
    }
    fn perform_ax(
        &mut self,
        session: &str,
        action: &Value,
        dispatched: &mut bool,
    ) -> Result<bool, String> {
        let name = field(action, "action")?;
        let observation = self.current(session, action)?;
        self.require_background(self.validate_app(&self.windows[&observation.window].app)?)?;
        if name == "ax_action" && matches!(field(action, "name")?, "AXRaise" | "AXShowMenu") {
            return Err("该动作需要前台焦点，后台模式不支持".into());
        }
        let reference = observation
            .refs
            .get(field(action, "ref")?)
            .ok_or("控件引用不属于此观察")?;
        if reference.element.fingerprint() != Ok(reference.fingerprint.clone()) {
            return Err("控件语义已经变化，请重新 observe".into());
        }
        let before = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier());
        if name == "ax_action" {
            reference.element.validate_action(field(action, "name")?)?;
        } else {
            reference.element.validate_value()?;
        }
        *dispatched = true;
        if name == "ax_action" {
            reference.element.perform(field(action, "name")?)?;
        } else {
            reference.element.set_value(field(action, "value")?)?;
        }
        let after = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier());
        if before != after {
            if let Some(lease) = self.lease.take() {
                self.paused.insert(lease.session);
            }
            self.observations.retain(|(owner, _), _| owner != session);
            return Ok(true);
        }
        Ok(false)
    }
    /// 文本输入绑定真实 AX 控件和窗口租约，选择不以坐标或名称重新寻找目标。
    fn perform_text(
        &self,
        session: &str,
        app: &str,
        window: &str,
        action: &Value,
        cancel: &AtomicBool,
        dispatched: &mut bool,
    ) -> Result<TextInteraction, String> {
        let observation = self.current(session, action)?;
        let reference = observation
            .refs
            .get(field(action, "ref")?)
            .ok_or("文本控件引用不属于当前观察")?;
        let paste = field(action, "action")? == "paste";
        let check = || {
            self.background(session, window, cancel)?;
            self.current(session, action)?;
            if reference.element.fingerprint() != Ok(reference.fingerprint.clone()) {
                return Err("文本控件语义已经变化，请重新 observe".into());
            }
            if paste {
                self.check_input_frame(app, window, "key", observation.bounds)?;
                if !self.apps[app]
                    .root
                    .element("AXFocusedUIElement")?
                    .same(&reference.element)
                {
                    return Err("粘贴目标不是当前应用内的焦点控件，未发送按键".into());
                }
            }
            Ok(())
        };
        check()?;
        let value = reference.element.editable_text()?;
        if paste {
            return self.paste_text(
                session,
                NativePasteTarget::new(
                    reference.element.clone(),
                    self.apps[app].native.clone(),
                    reference.fingerprint.clone(),
                ),
                &value,
                action,
                check,
                dispatched,
            );
        }
        let range = text_selection::locate(
            &value,
            TextSelection {
                text: field(action, "text")?,
                prefix: action.get("prefix").and_then(Value::as_str),
                suffix: action.get("suffix").and_then(Value::as_str),
                position: action
                    .get("position")
                    .and_then(Value::as_str)
                    .unwrap_or("select"),
            },
        )?;
        check()?;
        if reference.element.editable_text()? != value {
            return Err("定位期间控件文字已经变化，未修改选区".into());
        }
        *dispatched = true;
        reference.element.set_selected_range(range)?;
        check()?;
        if reference.element.selected_range()? != range
            || reference.element.editable_text()? != value
        {
            return Err("AX 未确认请求的选区或文字已变化，禁止自动重放".into());
        }
        Ok(TextInteraction::Completed(
            json!({"selection":{"location":range.location,"length":range.length}}),
        ))
    }

    /// 粘贴只在窗口及具体控件仍授权且保持焦点时派发，按实际文本变化确认后再恢复剪贴板。
    fn paste_text(
        &self,
        session: &str,
        target: NativePasteTarget,
        before: &str,
        action: &Value,
        check: impl Fn() -> Result<(), String>,
        dispatched: &mut bool,
    ) -> Result<TextInteraction, String> {
        let element = &target.element;
        let range = element.selected_range()?;
        let bytes = text_selection::byte_range(before, range)?;
        let text = field(action, "text")?;
        let mut expected = before.to_owned();
        expected.replace_range(bytes, text);
        if expected == before {
            return Err("粘贴不会改变可核验文字，未派发输入".into());
        }
        let mut clipboard = ClipboardTransaction::prepare(NSPasteboard::generalPasteboard())?;
        check()?;
        let mut key_dispatched = false;
        let send = (|| {
            if element.editable_text()? != before || element.selected_range()? != range {
                return Err("准备粘贴期间目标文字或选区发生变化".into());
            }
            check()?;
            *dispatched = true;
            clipboard.install(PasteContent {
                text,
                html: action.get("html").and_then(Value::as_str),
                rtf: action.get("rtf").and_then(Value::as_str),
            })?;
            clipboard.require_owned()?;
            input::key(
                input::ProcessTarget::new(target.app.processIdentifier())?,
                "Meta+v",
                || {
                    check()?;
                    clipboard.require_owned()
                },
                &mut key_dispatched,
            )
        })();
        *dispatched |= key_dispatched;
        let token = uuid::Uuid::new_v4().to_string();
        let mut pending = if key_dispatched {
            let mut pending =
                NativePendingPaste::new(target, clipboard, expected, token, session.into());
            if let Err(error) = send {
                pending.interrupted(error);
            }
            pending
        } else {
            let error = send.err().unwrap_or_else(|| "粘贴按键没有派发".into());
            match clipboard.restore() {
                Ok(_) => return Err(error),
                Err(restore) => NativePendingPaste::recovery(
                    target,
                    clipboard,
                    token,
                    session.into(),
                    format!("{error}；剪贴板恢复失败：{restore}"),
                ),
            }
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // V 已投递后只能查询消费，取消或失去焦点都不能立即替换它尚未消费的剪贴板。
            if let Err(error) = check() {
                pending.interrupted(error);
            }
            match pending.poll() {
                Ok(Some(settled)) => return Ok(TextInteraction::Settled(settled)),
                Ok(None) => {}
                Err(_) => return Ok(TextInteraction::Pending(pending)),
            }
            if Instant::now() >= deadline {
                return Ok(TextInteraction::Pending(pending));
            }
            input::pump();
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn perform_input(
        &self,
        session: &str,
        app: &str,
        window: &str,
        action: &Value,
        cancel: &AtomicBool,
        dispatched: &mut bool,
    ) -> Result<(), String> {
        let name = field(action, "action")?;
        let observation = self.current(session, action)?;

        self.background(session, window, cancel)?;
        let check = || {
            self.background(session, window, cancel)?;
            self.check_input_frame(app, window, name, observation.bounds)
        };
        self.input_window(app, action, observation, check, dispatched)
    }

    fn check_input_frame(
        &self,
        app: &str,
        window: &str,
        name: &str,
        bounds: Bounds,
    ) -> Result<(), String> {
        if matches!(name, "type" | "key" | "scroll")
            && !self.apps[app]
                .root
                .element("AXFocusedWindow")?
                .same(&self.windows[window].element)
        {
            return Err("目标不是应用内部的输入窗口，请先选择输入位置；不会激活应用".into());
        }
        if self.windows[window].element.bounds()? != bounds {
            return Err("窗口位置或尺寸变化，输入已经暂停".into());
        }
        Ok(())
    }

    /// 模型与人工输入共用坐标映射和成对事件，授权检查由各自的来源契约提供。
    fn input_window(
        &self,
        app: &str,
        action: &Value,
        observation: &Observation,
        check: impl Fn() -> Result<(), String>,
        dispatched: &mut bool,
    ) -> Result<(), String> {
        let name = field(action, "action")?;
        let point = |x: f64, y: f64| -> Result<CGPoint, String> {
            let mapping = observation
                .screenshot
                .as_ref()
                .ok_or("坐标输入必须基于当前截图")?
                .pixels;
            let (x, y) = mapping.screen_point(x, y)?;
            Ok(CGPoint { x, y })
        };
        let process = input::ProcessTarget::new(self.apps[app].pid)?;
        let window_target = || {
            input::WindowTarget::new(
                self.apps[app].pid,
                observation
                    .screenshot
                    .as_ref()
                    .ok_or("坐标输入需要先获取当前窗口截图")?
                    .window_id,
                CGPoint {
                    x: observation.bounds.x,
                    y: observation.bounds.y,
                },
            )
        };
        match name {
            "pointer" | "pointer_event" => {
                let point = point(number(action, "x")?, number(action, "y")?)?;
                let clicks = match action.get("clicks") {
                    None => 1,
                    Some(value) => u32::try_from(value.as_u64().ok_or("点击编号不是正整数")?)
                        .map_err(|_| "点击编号超限")?,
                };
                let send = if name == "pointer_event" {
                    input::pointer_event
                } else {
                    input::pointer
                };
                send(
                    window_target()?,
                    point,
                    action
                        .get("button")
                        .and_then(Value::as_str)
                        .unwrap_or("left"),
                    clicks,
                    check,
                    dispatched,
                )?;
            }
            "drag" => {
                let from = point(number(action, "from_x")?, number(action, "from_y")?)?;
                let to = point(number(action, "to_x")?, number(action, "to_y")?)?;
                input::drag(window_target()?, from, to, check, dispatched)?;
            }
            "type" => input::text(process, field(action, "text")?, check, dispatched)?,
            "key" => input::key(process, field(action, "key")?, check, dispatched)?,
            "scroll" => {
                let center = CGPoint {
                    x: observation.bounds.x + observation.bounds.width / 2.0,
                    y: observation.bounds.y + observation.bounds.height / 2.0,
                };
                let center = if action.get("at_x").is_some() && action.get("at_y").is_some() {
                    point(number(action, "at_x")?, number(action, "at_y")?)?
                } else {
                    center
                };
                input::scroll(
                    window_target()?,
                    center,
                    number(action, "x")?,
                    number(action, "y")?,
                    check,
                    dispatched,
                )?;
            }
            _ => {
                *dispatched = false;
                return Err("不支持的原生动作".into());
            }
        }
        Ok(())
    }
}
fn field<'a>(action: &'a Value, name: &str) -> Result<&'a str, String> {
    action
        .get(name)
        .and_then(Value::as_str)
        .filter(|v| v.len() <= 65536)
        .ok_or_else(|| format!("原生动作缺少有效 {name}"))
}
fn number(action: &Value, name: &str) -> Result<f64, String> {
    action
        .get(name)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("原生坐标 {name} 无效"))
}
