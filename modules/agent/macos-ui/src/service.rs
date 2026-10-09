//! 原生资源与控制权状态机；句柄按进程启动身份和实际 AX 对象归属。
use super::{
    ax::{self, Bounds, Element},
    input, screen,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
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
}
/// 像素映射和窗口编号来自同一次截图，禁止出现只更新其中一项的状态。
struct WindowCapture {
    pixels: super::geometry::PixelMapping,
    window_id: u32,
}
/// 后台授权只属于一个会话和窗口；用户切换到目标应用时暂停，避免争用。
struct Lease {
    session: String,
    window: String,
    app: String,
}

/// 主线程拥有的原生服务；只接收已认证 broker 的命令，不接受任意系统指针。
pub struct Service {
    apps: BTreeMap<String, App>,
    windows: BTreeMap<String, Window>,
    observations: BTreeMap<(String, String), Observation>,
    lease: Option<Lease>,
    protected: Vec<i32>,
    paused: BTreeSet<String>,
}
impl Service {
    /// 创建当前主线程的原生资源所有者；protected 是可信宿主与 helper 的进程身份。
    /// 非主线程调用返回错误，不请求或自动批准 OS 权限。
    pub fn new(protected: Vec<i32>) -> Result<Self, String> {
        MainThreadMarker::new().ok_or("原生服务必须在主线程创建")?;
        Ok(Self {
            apps: Default::default(),
            windows: Default::default(),
            observations: Default::default(),
            lease: None,
            protected,
            paused: Default::default(),
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
        self.update_control();
        std::mem::take(&mut self.paused).into_iter().collect()
    }
    /// 释放会话控制权和观察，不关闭用户应用；关闭连接时必须调用。
    pub fn release(&mut self, session: &str) {
        if session == "*" {
            self.observations.clear();
            self.lease = None;
        } else {
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
                json!({"outcome":if dispatched{"unknown"}else{"not_executed"},"error":error,"mode":"background"})
            }
        };
        if let Some(bundle) = action
            .get("window")
            .and_then(Value::as_str)
            .and_then(|window| self.windows.get(window))
            .and_then(|window| self.apps.get(&window.app))
            .map(|app| &app.bundle)
        {
            output["bundle_id"] = json!(bundle);
        }
        output
    }
    fn update_apps(&mut self) -> Result<Value, String> {
        let native = NSWorkspace::sharedWorkspace().runningApplications();
        let mut output = Vec::new();
        let mut live = std::collections::BTreeSet::new();
        for app in native.iter() {
            let pid = app.processIdentifier();
            if self.protected.contains(&pid) || pid == std::process::id() as i32 {
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
            },
        );
        Ok(
            json!({"outcome":"observed","observation":observation,"bundle_id":self.apps[&entry.app].bundle,"mode":"background"}),
        )
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
        match name {
            "permissions" => {
                return Ok(
                    json!({"outcome":"observed","accessibility":ax::trusted(),"screen_recording":screen::permitted(),"input_monitoring":input::monitoring_permitted()}),
                );
            }
            "apps" => return self.update_apps(),
            "windows" => return self.list_windows(field(action, "app")?),
            "handoff" | "invalidate" => {
                self.release(session);
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
            return self.preview(&app, &window, cancel);
        }
        if name == "observe" {
            return self.observe(session, &window);
        }
        if name == "grant_control" {
            return self.grant_control(session, app, window);
        }
        if name == "screenshot" {
            return self.capture_window(session, &app, &window, cancel);
        }
        if matches!(name, "ax_action" | "set_value") {
            if self.perform_ax(session, action, dispatched)? {
                return Ok(
                    json!({"outcome":"executed","mode":"human","error":"目标应用改变了焦点，后台操作已暂停"}),
                );
            }
        } else {
            self.perform_input(session, &app, &window, action, cancel, dispatched)?;
        }
        let mut result = self.observe(session, &window)?;
        result["outcome"] = json!("executed");
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
        self.lease = Some(lease);
        let mut result = self.observe(session, &window)?;
        result["outcome"] = json!("executed");
        Ok(result)
    }
    fn preview(&self, app: &str, window: &str, cancel: &AtomicBool) -> Result<Value, String> {
        let entry = &self.windows[window];
        let image = screen::capture(
            self.apps[app].pid,
            entry.element.optional_text("AXTitle")?.unwrap_or_default(),
            entry.element.bounds()?,
            || cancel.load(Ordering::Acquire),
        )?;
        Ok(
            json!({"outcome":"observed", "image_data":STANDARD.encode(image.bytes), "image_format":"jpeg"}),
        )
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
            entry.title.clone(),
            entry.bounds,
            || cancel.load(Ordering::Acquire),
        )?;
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
            if matches!(name, "type" | "key" | "scroll")
                && !self.apps[app]
                    .root
                    .element("AXFocusedWindow")?
                    .same(&self.windows[window].element)
            {
                return Err("目标不是应用内部的输入窗口，请先选择输入位置；不会激活应用".into());
            }
            if self.windows[window].element.bounds()? != observation.bounds {
                Err("窗口位置或尺寸变化，输入已经暂停".into())
            } else {
                Ok(())
            }
        };
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
            )
        };
        match name {
            "pointer" => {
                let point = point(number(action, "x")?, number(action, "y")?)?;
                input::pointer(
                    window_target()?,
                    point,
                    action
                        .get("button")
                        .and_then(Value::as_str)
                        .unwrap_or("left"),
                    action.get("clicks").and_then(Value::as_u64).unwrap_or(1) as u32,
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
                input::scroll(
                    process,
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
