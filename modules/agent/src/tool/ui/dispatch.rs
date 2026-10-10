//! SDK 请求先通过类型契约，再进入宿主授权和独立后端；模型不能选择私有运行材料。
use super::{
    UiTool,
    computer::{ComputerInput, UiAccessDecision, UiAccessRequest},
    files,
};
use crate::{
    Image,
    tool::{Tool, ToolContext, ToolError, browser::BrowserInput},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;

impl UiTool {
    pub(super) fn sdk_info(&self, request: &Value) -> Value {
        if request["domain"] == "browser" {
            serde_json::json!({
                "domain": "browser", "backend": request["backend"],
                "capabilities": {
                    "vision": self.vision,
                    "network": if request["backend"] == "managed" { "managed_gateway" } else { "user_browser_network" },
                    "file_limit_bytes": files::FILE_LIMIT,
                    "observation_modes": ["full", "delta"],
                    "semantic_locators": true,
                    "extension_discovery": "p.capabilities.list()"
                },
                "usage": concat!(
                    "browser.get('managed'|'chrome'|'edge')；从真实 tabs 选 b.page(id)。p.observe() 获取 ref，或用 getByRole(role,{name})/getByLabel/getByText/getByPlaceholder/getByTestId 严格唯一定位。",
                    "定位器可链式查询及 filter；inspect()/count() 只读，click/fill/select/check/press 操作同一真实节点。p.frame({url:真实完整URL}) 或 iframe定位器.contentFrame() 进入框架。",
                    "observe({mode:'delta'}) 自动附带保留的基线，snapshot 还原完整观察。动作末尾 {observation_mode:'none'} 省略采集并撤销旧 ref/截图。",
                    "先 p.capabilities.list()/get(name) 获取当前后端支持和文档，再 requestCapability(name,reason) 请求 webmcp、developer_logs 或 cdp 独立授权；导航或接管后需重新授权。",
                    "p.logs({after,limit}) 读日志；p.webmcp.list()/call(directory,tool,input,options) 使用当前真实目录；p.cdp.send(method,params) 只接受文档列出的只读方法。网页声明不授予权限。",
                    "p.download(async()=>{...}) 等待下载，b.saveDownload(id,path) 保存到工作区；emitImage(await p.screenshot()) 返回截图。检查 outcome，unknown 不重放。managed 用户协助用 p.handoff({type:'text',text:'明确成功提示'}) 或 {type:'url',url:'精确成功地址'}，必须基于实际业务指定正向成功证据；系统观察稳定满足后自动继续，无需完成按钮。恢复后先 tabs/observe 检查 handoff.status/error 并核验网页；chrome/edge 沿用 b.handoff() 由可信界面交还。"
                )
            })
        } else {
            serde_json::json!({
                "domain": "computer",
                "capabilities": {
                    "vision": self.vision,
                    "backend": "macos_accessibility_screencapturekit",
                    "input": "process_directed_background",
                    "launch_approval": self.launch_approver.is_some(),
                    "observation_modes": ["full", "delta"]
                },
                "usage": concat!(
                    "computer.apps()/permissions() 读取真实应用与系统权限；computer.getApp(id) 后从 app.state.windows 选 app.window(id)。computer.launchApp(bundle_id,reason) 单独请求本次后台启动，不接受路径或参数。",
                    "w.observe() 返回 AX ref，press(ref)/setValue(ref,value)/perform(ref,name) 使用控件支持的后台动作；selectText(ref,text,{prefix,suffix,position:'select'|'before'|'after'}) 要求唯一文本匹配及可写选择范围。",
                    "observe({mode:'delta'}) 返回增量，snapshot 保留完整证据；动作末尾 {observation_mode:'none'} 省略采集并撤销旧引用与截图。",
                    "文本选择、坐标、拖动、键盘、滚动与 paste(ref,text,{html,rtf}) 需要 requestControl(reason) 人工授权；粘贴还要求真实控件已聚焦、支持 AX 文本范围且应用能消费后台 Command+V，AX 焦点不保证菜单响应链可后台执行。text 须与富文本实际粘贴出的文字一致；无文字变化的纯格式替换拒绝派发。仅在剪贴板未被其他程序修改时恢复全部原格式。",
                    "粘贴派发后最多同步等待五秒；取消不会撤回已排队输入。unknown 且 clipboard_pending:true 时，用 computer.permissions() 查询 clipboard_token 与 clipboard_settlement；原生输入保持暂停，直至确认消费、原应用退出或剪贴板被接管后安全结算，禁止重放。",
                    "截图坐标操作前须重新 screenshot；权限由用户在系统设置授予，人工接管后模型不能自行恢复。检查真实 outcome，unknown 不重放。"
                )
            })
        }
    }
    pub(super) async fn dispatch(
        &self,
        request: Value,
        context: ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        context
            .execution
            .check()
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        match request.get("domain").and_then(Value::as_str) {
            Some("browser") => self.dispatch_browser(request, context).await,
            Some("computer") => self.dispatch_computer(request, context).await,
            _ => Err(ToolError::Execution("不支持的 UI SDK 命名空间".into())),
        }
    }
    async fn dispatch_browser(
        &self,
        request: Value,
        context: ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        let backend = request
            .get("backend")
            .and_then(Value::as_str)
            .filter(|v| matches!(*v, "managed" | "chrome" | "edge"))
            .ok_or_else(|| ToolError::Execution("浏览器后端无效".into()))?;
        let mut value = request.get("action").cloned().unwrap_or(Value::Null);
        self.browser_schema
            .validate(&value)
            .map_err(|e| ToolError::Execution(format!("浏览器动作不符合 Schema：{e}")))?;
        if value["action"] == "request_capability" {
            return self.request_capability(backend, &value, &context).await;
        }
        if value["action"] == "webmcp_call" {
            return self.call_webmcp(backend, &value, &context).await;
        }
        if backend != "managed" {
            if !self.vision
                && matches!(
                    value.get("action").and_then(Value::as_str),
                    Some("screenshot" | "pointer" | "drag")
                )
            {
                return Err(ToolError::Execution(
                    "当前模型没有视觉能力，请使用 DOM 控件".into(),
                ));
            }
            if matches!(
                value.get("action").and_then(Value::as_str),
                Some("upload" | "choose_files")
            ) {
                let paths: Vec<String> =
                    serde_json::from_value(value.get("paths").cloned().unwrap_or(Value::Null))
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                let files = self
                    .files
                    .as_ref()
                    .ok_or_else(|| ToolError::Execution("宿主未提供文件读取边界".into()))?
                    .upload(&paths)
                    .map_err(ToolError::Execution)?;
                value["action"] = serde_json::json!(if value["action"] == "upload" {
                    "upload_bytes"
                } else {
                    "choose_files_bytes"
                });
                value["files"] = serde_json::to_value(files)
                    .map_err(|e| ToolError::Infrastructure(e.to_string()))?;
                if let Some(object) = value.as_object_mut() {
                    object.remove("paths");
                }
            }
            if value["action"] == "save_download" {
                let config = self
                    .connections
                    .as_ref()
                    .ok_or_else(|| ToolError::Execution("UI 连接未启用".into()))?;
                let id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ToolError::Execution("下载身份缺失".into()))?;
                let path = value
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ToolError::Execution("保存路径缺失".into()))?;
                let source = config
                    .broker
                    .artifact(context.session.id(), id)
                    .map_err(ToolError::Execution)?;
                let saved = self
                    .files
                    .as_ref()
                    .ok_or_else(|| ToolError::Execution("文件边界未配置".into()))?
                    .save(&source, path)
                    .map_err(ToolError::Execution)?;
                return Ok((
                    serde_json::json!({"outcome":"executed","saved_path":saved}),
                    None,
                ));
            }
            return self.remote(backend, value, &context).await;
        }
        let action = serde_json::from_value(value)
            .map_err(|e| ToolError::Execution(format!("浏览器动作无效：{e}")))?;
        let browser = self
            .browser
            .as_ref()
            .ok_or_else(|| ToolError::Execution("宿主未启用专用浏览器".into()))?;
        if let Some(config) = &self.connections
            && context
                .session
                .ui()
                .needs_browser_invalidation(&config.broker)
        {
            let mut invalidation = context.clone();
            invalidation.call_id = format!("{}:invalidate", context.call_id);
            browser
                .execute(BrowserInput::Invalidate, invalidation)
                .await?;
        }
        let action_name = request["action"]["action"].as_str().unwrap_or("");
        let mut output = match browser.execute(action, context).await {
            Ok(output) => output,
            Err(error) => {
                return Ok((
                    serde_json::json!({"error":error.to_string(),"outcome":"unknown"}),
                    None,
                ));
            }
        };
        let image = output.image.take();
        let value =
            serde_json::to_value(output).map_err(|e| ToolError::Infrastructure(e.to_string()))?;
        if let Some(config) = &self.connections {
            config.broker.notify_effect("managed", action_name, &value);
        }
        Ok((value, image))
    }
    async fn dispatch_computer(
        &self,
        request: Value,
        context: ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        let value = request.get("action").cloned().unwrap_or(Value::Null);
        self.computer_schema
            .validate(&value)
            .map_err(|e| ToolError::Execution(format!("原生动作不符合 Schema：{e}")))?;
        serde_json::from_value::<ComputerInput>(value.clone())
            .map_err(|e| ToolError::Execution(e.to_string()))?
            .validate()
            .map_err(ToolError::Execution)?;
        let name = value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if !self.vision && matches!(name.as_str(), "screenshot" | "pointer" | "drag") {
            return Err(ToolError::Execution(
                "当前模型没有视觉能力，请使用 AX 结构".into(),
            ));
        }
        self.ensure_computer(&context).await?;
        if name == "launch_app" {
            return self.request_launch(&value, &context).await;
        }
        if name == "request_control" {
            return self.request_control(&value, &context).await;
        }
        self.remote("computer", value, &context).await
    }
    async fn request_control(
        &self,
        value: &Value,
        context: &ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        if self
            .connections
            .as_ref()
            .is_some_and(|config| config.broker.paused(context.session.id(), "computer"))
        {
            return Err(ToolError::Execution(
                "人工接管后只能从可信界面交还控制，模型不能重新申请来恢复输入".into(),
            ));
        }
        let app = value
            .get("app")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Execution("后台控制缺少应用".into()))?
            .to_owned();
        let window = value
            .get("window")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Execution("后台控制缺少窗口".into()))?
            .to_owned();
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| ToolError::Execution("请说明后台控制用途".into()))?
            .to_owned();
        let (current, _) = self
            .remote(
                "computer",
                serde_json::json!({"action":"control_state","app":app,"window":window}),
                context,
            )
            .await?;
        if current.get("error").is_some() {
            return Ok((current, None));
        }
        if current.get("granted").and_then(Value::as_bool) == Some(true) {
            return Ok((current, None));
        }

        let approver = self
            .approver
            .as_ref()
            .ok_or_else(|| ToolError::Execution("宿主未提供后台审批入口".into()))?;
        let request = UiAccessRequest {
            app: app.clone(),
            window: window.clone(),
            reason,
            app_name: current
                .get("app_name")
                .and_then(Value::as_str)
                .unwrap_or(&app)
                .into(),
            window_title: current
                .get("window_title")
                .and_then(Value::as_str)
                .unwrap_or("目标窗口")
                .into(),
        };
        match approver
            .approve(request.clone(), context.execution.clone())
            .await
            .map_err(ToolError::Execution)?
        {
            UiAccessDecision::AllowForSession => {}
            UiAccessDecision::Deny(reason) => {
                return Err(ToolError::Execution(format!("后台控制被拒绝：{reason}")));
            }
        }
        context.session.ui().set_control(request);
        return self
            .remote(
                "computer",
                serde_json::json!({"action":"grant_control","app":app,"window":window}),
                context,
            )
            .await;
    }
    pub(super) async fn remote(
        &self,
        backend: &str,
        action: Value,
        context: &ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        let connections = self
            .connections
            .as_ref()
            .ok_or_else(|| ToolError::Execution("宿主尚未启用 UI 连接".into()))?;
        let session = context.session.id();
        match connections
            .broker
            .execute(session, backend, action, &context.execution)
            .await
        {
            Ok(mut value) => {
                if let Some(object) = value.as_object_mut() {
                    object.insert(
                        "recent_operations".into(),
                        serde_json::to_value(connections.broker.receipts(session))
                            .map_err(|e| ToolError::Infrastructure(e.to_string()))?,
                    );
                }
                let image = match decode_image(&value) {
                    Ok(image) => image,
                    Err(error) => {
                        value["error"] = serde_json::json!(error);
                        None
                    }
                };
                if let Some(object) = value.as_object_mut() {
                    object.remove("image_data");
                    object.remove("image_format");
                }
                Ok((value, image))
            }
            Err(error) => Ok((
                serde_json::json!({"error":error.to_string(),"outcome":error.outcome()}),
                None,
            )),
        }
    }
    async fn ensure_computer(&self, context: &ToolContext) -> Result<(), ToolError> {
        let connections = self
            .connections
            .as_ref()
            .ok_or_else(|| ToolError::Execution("宿主尚未启用原生服务".into()))?;
        let helper = connections
            .computer_helper
            .as_ref()
            .ok_or_else(|| ToolError::Execution("Computer Use 需要 macOS 14+".into()))?;
        connections
            .broker
            .ensure_computer(helper, &context.execution)
            .await
            .map_err(ToolError::Execution)
    }
    pub(crate) async fn control(
        &self,
        context: ToolContext,
        backend: &str,
        resume: bool,
    ) -> Result<Value, ToolError> {
        let action = if backend == "computer" && resume {
            let control = context.session.ui().snapshot().control.ok_or_else(|| {
                ToolError::Execution("没有已由人批准的窗口，请先选择窗口并请求控制".into())
            })?;
            serde_json::json!({"action":"grant_control","app":control.app,"window":control.window})
        } else {
            serde_json::json!({"action":if resume{"resume"}else{"handoff"}})
        };
        self.remote(backend, action, &context)
            .await
            .map(|(value, _)| value)
    }
    pub(crate) async fn permissions(&self, context: ToolContext) -> Result<Value, ToolError> {
        self.ensure_computer(&context).await?;
        self.remote(
            "computer",
            serde_json::json!({"action":"permissions"}),
            &context,
        )
        .await
        .map(|(value, _)| value)
    }

    /// 可信宿主读取已批准窗口的画面；不更新模型控件观察，失败保留后端原因。
    pub(crate) async fn preview(
        &self,
        context: ToolContext,
        backend: &str,
        action: Value,
    ) -> Result<(Image, Option<String>), ToolError> {
        let (value, image) = self.remote(backend, action, &context).await?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(ToolError::Execution(error.into()));
        }
        let token = value
            .get("input_token")
            .and_then(Value::as_str)
            .map(str::to_owned);
        image
            .map(|image| (image, token))
            .ok_or_else(|| ToolError::Execution("原生预览未返回画面".into()))
    }

    /// 可信界面的人工输入不进入模型 SDK；后端再次验证图像凭据和此前批准的窗口。
    pub(crate) async fn preview_input(
        &self,
        context: ToolContext,
        action: Value,
    ) -> Result<(), ToolError> {
        let (value, _) = self.remote("computer", action, &context).await?;
        if value["outcome"] != "executed" {
            return Err(ToolError::Execution(
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("原生输入未确认执行")
                    .into(),
            ));
        }
        Ok(())
    }
}

fn decode_image(value: &Value) -> Result<Option<Image>, String> {
    let Some(encoded) = value.get("image_data").and_then(Value::as_str) else {
        return Ok(None);
    };
    if encoded.len() > 5 * 1024 * 1024 * 4 / 3 + 4 {
        return Err("UI 截图编码超过附件预算".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "UI 截图编码无效")?;
    let format = match value.get("image_format").and_then(Value::as_str) {
        Some("jpeg") => crate::ImageFormat::Jpeg,
        Some("png") => crate::ImageFormat::Png,
        _ => return Err("UI 截图格式无效".into()),
    };
    Image::new(format, bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}
