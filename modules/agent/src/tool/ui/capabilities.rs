//! 浏览器扩展审批只由宿主提供，网络权限与页面声明不能充当能力授权。
use super::UiTool;
use crate::ExecutionContext;
use crate::{
    Image,
    tool::{Tool, ToolContext, ToolError, browser::BrowserInput},
};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// 当前文档内独立审批的能力；WebMCP 可能改变业务状态，CDP 只读诊断范围由后端固定。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrowserCapability {
    /// 调用真实浏览器登记的网页工具，不能依赖 readOnly 提示绕过批准。
    Webmcp,
    /// 读取当前页面的有界控制台、异常及开发日志。
    DeveloperLogs,
    /// 读取固定页面 session 的受控 CDP 诊断，不能执行脚本或访问其他目标。
    Cdp,
}

/// 宿主从实际后端准备的不可变申请；导航、目录或控制权变化后不能沿用。
#[derive(Clone, Debug, Serialize)]
pub struct BrowserCapabilityRequest {
    /// 用户已连接的真实浏览器后端。
    pub backend: String,
    /// 当前会话真实页面身份。
    pub page: String,
    /// 页面后端分配的文档代次。
    pub document: String,
    /// 实际文档的完整 HTTP(S) 来源，空页不能申请授权。
    pub origin: String,
    /// 真实标签元数据，仅供用户辨识，不能构成批准。
    pub title: String,
    /// 用户将批准的独立能力范围。
    pub capability: BrowserCapability,
    /// 模型说明的具体使用用途。
    pub reason: String,
}

/// 可信界面的能力决定；授权只在当前文档与控制权生命周期内复用。
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "decision",
    content = "details",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum BrowserCapabilityDecision {
    /// 当前会话的当前文档允许该能力，导航、接管或断开立即失效。
    AllowForSession,
    /// 拒绝该能力并保留用户原因。
    Deny(String),
}

/// 页面与模型均不能实现这个宿主审批边界；缺少审批入口时默认拒绝。
#[async_trait]
pub trait BrowserCapabilityApprover: Send + Sync {
    /// 在 context 的取消与截止时间内等待 request 的明确决定。
    /// 返回当前文档的会话授权或拒绝；取消、超时及审批通道故障返回错误，不授予权限。
    async fn approve(
        &self,
        request: BrowserCapabilityRequest,
        context: ExecutionContext,
    ) -> Result<BrowserCapabilityDecision, String>;
}

impl UiTool {
    pub(super) async fn request_capability(
        &self,
        backend: &str,
        value: &Value,
        context: &ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        let action: BrowserInput = serde_json::from_value(value.clone())
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let BrowserInput::RequestCapability {
            page,
            capability,
            reason,
        } = action
        else {
            return Err(ToolError::Execution("能力申请类型无效".into()));
        };
        if reason.trim().is_empty() {
            return Err(ToolError::Execution("请说明浏览器能力用途".into()));
        }
        let (state, _) = self
            .extension_backend(
                backend,
                json!({"action":"extension_state","page":page}),
                context,
            )
            .await?;
        if state.get("error").is_some() {
            return Ok((state, None));
        }
        let extensions = state
            .get("extensions")
            .ok_or_else(|| ToolError::Execution("浏览器未返回真实能力状态".into()))?;
        let capability_name = serde_json::to_value(capability)
            .map_err(|e| ToolError::Infrastructure(e.to_string()))?;
        let offered = extensions
            .get("capabilities")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| item["name"] == capability_name))
            .ok_or_else(|| ToolError::Execution("当前后端不支持该能力，未请求批准".into()))?;
        if offered["granted"].as_bool() == Some(true) {
            return Ok((state, None));
        }
        let field = |key: &str| -> Result<String, ToolError> {
            extensions
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| ToolError::Execution(format!("能力审批缺少真实 {key}")))
        };
        let document = field("document")?;
        let origin = field("origin")?;
        let revision = field("revision")?;
        let url = url::Url::parse(&origin)
            .map_err(|_| ToolError::Execution("能力审批的网站来源无效".into()))?;
        if !matches!(url.scheme(), "http" | "https") || url.origin().ascii_serialization() != origin
        {
            return Err(ToolError::Execution("能力审批需要真实完整网站来源".into()));
        }
        let title = state
            .get("tabs")
            .and_then(Value::as_array)
            .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_str() == Some(&page)))
            .and_then(|tab| tab["title"].as_str())
            .unwrap_or("当前页面")
            .to_owned();
        let approver = self
            .capability_approver
            .as_ref()
            .ok_or_else(|| ToolError::Execution("宿主未提供浏览器能力审批入口".into()))?;
        let request = BrowserCapabilityRequest {
            backend: backend.into(),
            page: page.clone(),
            document: document.clone(),
            origin: origin.clone(),
            title,
            capability,
            reason,
        };
        match approver
            .approve(request, context.execution.clone())
            .await
            .map_err(ToolError::Execution)?
        {
            BrowserCapabilityDecision::AllowForSession => {}
            BrowserCapabilityDecision::Deny(reason) => {
                return Err(ToolError::Execution(format!("浏览器能力被拒绝：{reason}")));
            }
        }
        context
            .execution
            .check()
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        self.extension_backend(backend, json!({"action":"grant_capability","page":page,"document":document,"origin":origin,"revision":revision,"capability":capability}), context).await
    }

    pub(super) async fn call_webmcp(
        &self,
        backend: &str,
        value: &Value,
        context: &ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        let mut prepare = value.clone();
        prepare["action"] = json!("webmcp_prepare");
        if let Some(object) = prepare.as_object_mut() {
            object.remove("observation_mode");
        }
        let (output, _) = self.extension_backend(backend, prepare, context).await?;
        if output.get("error").is_some() {
            return Ok((output, None));
        }
        let prepared = output
            .get("extensions")
            .ok_or_else(|| ToolError::Execution("WebMCP 未返回准备身份".into()))?;
        let schema = prepared
            .get("schema")
            .ok_or_else(|| ToolError::Execution("WebMCP 缺少真实输入 Schema".into()))?;
        reject_external_references(schema)?;
        let input = prepared
            .get("input")
            .ok_or_else(|| ToolError::Execution("WebMCP 缺少冻结输入".into()))?;
        // 网页提供的正则不能无限回溯；复杂或超限 Schema 作为未派发错误返回。
        let validator = jsonschema::options()
            .with_pattern_options(jsonschema::PatternOptions::fancy_regex().backtrack_limit(20000))
            .build(schema)
            .map_err(|e| ToolError::Execution(format!("WebMCP 工具 Schema 无效：{e}")))?;
        validator
            .validate(input)
            .map_err(|e| ToolError::Execution(format!("WebMCP 输入不符合 Schema：{e}")))?;
        let token = prepared
            .get("prepared")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Execution("WebMCP 准备身份无效".into()))?;
        context
            .execution
            .check()
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let mut invoke = json!({"action":"webmcp_invoke","page":value["page"],"prepared":token});
        if let Some(mode) = value.get("observation_mode") {
            invoke["observation_mode"] = mode.clone();
        }
        self.extension_backend(backend, invoke, context).await
    }

    async fn extension_backend(
        &self,
        backend: &str,
        value: Value,
        context: &ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        if backend != "managed" {
            return self.remote(backend, value, context).await;
        }
        let browser = self
            .browser
            .as_ref()
            .ok_or_else(|| ToolError::Execution("宿主未启用专用浏览器".into()))?;
        let name = value["action"].as_str().unwrap_or("invalid").to_owned();
        let mut stage = context.clone();
        stage.call_id = format!("{}:extension:{}", context.call_id, name);
        if let Some(config) = &self.connections
            && context
                .session
                .ui()
                .needs_browser_invalidation(&config.broker)
        {
            let mut invalidation = context.clone();
            invalidation.call_id = format!("{}:extension:invalidate", context.call_id);
            browser
                .execute(BrowserInput::Invalidate, invalidation)
                .await?;
        }
        let action: BrowserInput =
            serde_json::from_value(value).map_err(|e| ToolError::Execution(e.to_string()))?;
        let mut result = match browser.execute(action, stage).await {
            Ok(result) => result,
            Err(error) => {
                let output = json!({"outcome":"unknown","error":error.to_string()});
                if let Some(config) = &self.connections {
                    config.broker.notify_effect("managed", &name, &output);
                }
                return Ok((output, None));
            }
        };
        let image = result.image.take();
        let output =
            serde_json::to_value(result).map_err(|e| ToolError::Infrastructure(e.to_string()))?;
        if let Some(config) = &self.connections {
            config.broker.notify_effect("managed", &name, &output);
        }
        Ok((output, image))
    }
}

fn reject_external_references(value: &Value) -> Result<(), ToolError> {
    match value {
        Value::Object(object) => {
            for keyword in ["$ref", "$dynamicRef", "$recursiveRef"] {
                if object
                    .get(keyword)
                    .and_then(Value::as_str)
                    .is_some_and(|reference| !reference.starts_with('#'))
                {
                    return Err(ToolError::Execution(
                        "WebMCP Schema 只能引用本地定义，不能读取网络或文件引用".into(),
                    ));
                }
            }
            for child in object.values() {
                reject_external_references(child)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                reject_external_references(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}
