//! 可信桌面控制入口；模型输入不包含交还或重新授予控制的能力。
use super::DesktopSession;
use crate::{CancellationToken, Error, ExecutionContext, tool::ToolContext};
use serde_json::Value;
use std::time::Duration;

/// 可信浮窗选择已有资源；模型不能以此绕过观察和人工接管契约。
#[derive(serde::Deserialize)]
#[serde(tag = "backend", rename_all = "snake_case", deny_unknown_fields)]
pub enum UiPreviewTarget {
    /// 专用后台浏览器内的真实页面。
    Managed {
        /// 已登记页面身份。
        page: String,
    },
    /// 当前会话已共享的 Chrome 页面。
    Chrome {
        /// 扩展返回的真实页面身份。
        page: String,
    },
    /// 当前会话已共享的 Edge 页面。
    Edge {
        /// 扩展返回的真实页面身份。
        page: String,
    },
    /// 当前会话已批准的原生窗口。
    Computer {
        /// 已批准应用身份。
        app: String,
        /// 已批准窗口身份。
        window: String,
    },
}

/// 浮窗画面与人工输入凭据共同交付；只读后端永远不授予人工浏览器输入。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreviewFrame {
    /// 弹窗阻止截图时为空，界面保留上次画面并展示弹窗。
    pub image: Option<String>,
    /// 仅当前专用浏览器接管代次有效，页面或交互改变后作废。
    pub input_token: Option<String>,
}

impl DesktopSession {
    /// 用户工具栏接管并导航当前会话；不创建模型请求，原生导航失败原样返回。
    pub async fn browser_navigate(
        &self,
        command: crate::tool::browser::BrowserNavigation,
    ) -> Result<(), Error> {
        use crate::tool::{
            Tool,
            browser::{BrowserInput, BrowserNavigation},
        };
        self.browser_control(false).await?;
        let inner = &self.0.0;
        let browser = inner
            .browser
            .as_ref()
            .ok_or_else(|| Error::Config("浏览器未启用".into()))?;
        let context = ToolContext {
            call_id: format!("browser-navigation:{}", uuid::Uuid::new_v4()),
            execution: ExecutionContext::new(
                inner.state.closed.child_token(),
                Duration::from_secs(30),
            )?,
            session: inner.session.clone(),
        };
        if let BrowserNavigation::Open { url } | BrowserNavigation::Navigate { url, .. } = &command
        {
            let url = url::Url::parse(url).map_err(|_| Error::Config("浏览器地址无效".into()))?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(Error::Config("用户导航仅支持无凭据的 HTTP(S) 地址".into()));
            }
            browser
                .execute(
                    BrowserInput::AllowOrigin {
                        origin: url.origin().ascii_serialization(),
                    },
                    context.clone(),
                )
                .await
                .map_err(|error| Error::ToolInfrastructure(error.to_string()))?;
        }
        let result = browser
            .execute(BrowserInput::HumanNavigate { command }, context)
            .await
            .map_err(|error| Error::ToolInfrastructure(error.to_string()))?;
        if let Some(error) = result.error {
            return Err(Error::ToolInfrastructure(error));
        }
        Ok(())
    }

    /// 获取已有资源的独立画面，不启动模型、不覆盖模型观察、不写入历史。
    /// 页面、授权窗口或运行资源无效时返回错误。
    pub async fn ui_preview(&self, target: UiPreviewTarget) -> Result<UiPreviewFrame, Error> {
        use crate::tool::{Tool, browser::BrowserInput};
        let inner = &self.0.0;
        inner.state.ensure_open()?;
        let context = ToolContext {
            call_id: format!("ui-preview:{}", uuid::Uuid::new_v4()),
            execution: ExecutionContext::new(
                inner.state.closed.child_token(),
                Duration::from_secs(10),
            )?,
            session: inner.session.clone(),
        };
        let backend = match &target {
            UiPreviewTarget::Chrome { .. } => "chrome",
            UiPreviewTarget::Edge { .. } => "edge",
            _ => "computer",
        };
        let image = match target {
            UiPreviewTarget::Managed { page } => {
                let browser = inner
                    .browser
                    .as_ref()
                    .ok_or_else(|| Error::Config("浏览器未启用".into()))?;
                let output = browser
                    .execute(BrowserInput::Preview { page }, context)
                    .await
                    .map_err(|error| Error::ToolInfrastructure(error.to_string()))?;
                if let Some(error) = output.error {
                    return Err(Error::ToolInfrastructure(error));
                }
                return Ok(UiPreviewFrame {
                    image: output.image.map(|image| image.data_url()),
                    input_token: output.input_token,
                });
            }
            UiPreviewTarget::Chrome { page } | UiPreviewTarget::Edge { page } => {
                let ui = inner
                    .ui
                    .as_ref()
                    .ok_or_else(|| Error::Config("UI 服务未启用".into()))?;
                Some(
                    ui.preview(
                        context,
                        backend,
                        serde_json::json!({"action":"preview","page":page}),
                    )
                    .await
                    .map_err(|error| Error::ToolInfrastructure(error.to_string()))?,
                )
            }
            UiPreviewTarget::Computer { app, window } => {
                let control = inner
                    .session
                    .ui_snapshot()
                    .control
                    .ok_or_else(|| Error::Config("尚未选择并批准原生窗口".into()))?;
                if app != control.app || window != control.window {
                    return Err(Error::Config("预览窗口不属于此会话的授权".into()));
                }
                let ui = inner
                    .ui
                    .as_ref()
                    .ok_or_else(|| Error::Config("UI 服务未启用".into()))?;
                Some(
                    ui.preview(
                        context,
                        "computer",
                        serde_json::json!({"action":"preview","app":app,"window":window}),
                    )
                    .await
                    .map_err(|error| Error::ToolInfrastructure(error.to_string()))?,
                )
            }
        };
        image
            .map(|(image, input_token)| UiPreviewFrame {
                image: Some(image.data_url()),
                input_token,
            })
            .ok_or_else(|| Error::ToolInfrastructure("预览未返回画面".into()))
    }

    /// 可信画面的人工输入仅作用于此前批准且已接管的原生窗口，失败不派发到其他目标。
    pub async fn ui_input(
        &self,
        target: UiPreviewTarget,
        token: String,
        input: crate::tool::browser::BrowserHumanInput,
    ) -> Result<(), Error> {
        let UiPreviewTarget::Computer { app, window } = target else {
            return Err(Error::Config("此输入入口只用于原生应用画面".into()));
        };
        let inner = &self.0.0;
        inner.state.ensure_open()?;
        let snapshot = inner.session.ui_snapshot();
        let control = snapshot
            .control
            .ok_or_else(|| Error::Config("尚未批准原生窗口".into()))?;
        if control.app != app
            || control.window != window
            || !snapshot.connections.iter().any(|connection| {
                connection.backend == "computer" && connection.connected && connection.human
            })
        {
            return Err(Error::Config("窗口或人工控制权已经变化".into()));
        }
        if token.is_empty()
            || token.len() > 128
            || matches!(
                input,
                crate::tool::browser::BrowserHumanInput::Dialog { .. }
                    | crate::tool::browser::BrowserHumanInput::Files { .. }
            )
        {
            return Err(Error::Config("原生人工输入无效".into()));
        }
        let ui = inner
            .ui
            .as_ref()
            .ok_or_else(|| Error::Config("原生服务未启用".into()))?;
        ui.preview_input(ToolContext {
            call_id: format!("ui-input:{}", uuid::Uuid::new_v4()),
            execution: ExecutionContext::new(inner.state.closed.child_token(), Duration::from_secs(10))?,
            session: inner.session.clone(),
        }, serde_json::json!({"action":"human_input","app":app,"window":window,"token":token,"input":input})).await.map_err(|error| Error::ToolInfrastructure(error.to_string()))
    }

    /// 将浮窗的人工输入交给当前会话浏览器；运行时只在 human 状态接受。
    /// 无效页面、输入、会话关闭或尚未接管时拒绝，不恢复模型运行。
    pub async fn browser_input(
        &self,
        page: String,
        token: String,
        input: crate::tool::browser::BrowserHumanInput,
    ) -> Result<(), Error> {
        use crate::tool::{Tool, browser::BrowserInput};
        let inner = &self.0.0;
        inner.state.ensure_open()?;
        let browser = inner
            .browser
            .as_ref()
            .ok_or_else(|| Error::Config("浏览器未启用".into()))?;
        let output = browser
            .execute(
                BrowserInput::HumanInput { page, token, input },
                ToolContext {
                    call_id: format!("browser-input:{}", uuid::Uuid::new_v4()),
                    execution: ExecutionContext::new(
                        inner.state.closed.child_token(),
                        Duration::from_secs(10),
                    )?,
                    session: inner.session.clone(),
                },
            )
            .await
            .map_err(|error| Error::ToolInfrastructure(error.to_string()))?;
        if let Some(error) = output.error {
            return Err(Error::ToolInfrastructure(error));
        }
        Ok(())
    }
    /// 用户检查原生权限时启动已签名 helper，只读取状态，不自动授予 OS 权限。
    /// 会话关闭、非 macOS 或运行材料不完整时返回错误。
    pub async fn ui_permissions(&self) -> Result<Value, Error> {
        let inner = &self.0.0;
        inner.state.ensure_open()?;
        let ui = inner
            .ui
            .as_ref()
            .ok_or_else(|| Error::Config("UI 服务未启用".into()))?;
        ui.permissions(ToolContext {
            call_id: format!("ui-permissions:{}", uuid::Uuid::new_v4()),
            execution: ExecutionContext::new(CancellationToken::new(), Duration::from_secs(15))?,
            session: inner.session.clone(),
        })
        .await
        .map_err(|e| Error::ToolInfrastructure(e.to_string()))
    }
    /// 人工接管暂停并结算当前脚本；交还后继续同一运行，不新增提示词。
    /// backend 为 managed、chrome、edge 或 computer；其他来源与未知窗口均拒绝。
    pub async fn ui_control(&self, backend: &str, resume: bool) -> Result<Value, Error> {
        if backend == "managed" {
            return serde_json::to_value(self.browser_control(resume).await?)
                .map_err(|e| Error::Protocol(e.to_string()));
        }
        if !matches!(backend, "chrome" | "edge" | "computer") {
            return Err(Error::Config("UI 后端无效".into()));
        }
        let inner = &self.0.0;
        inner.state.ensure_open()?;
        if resume
            && inner
                .state
                .snapshot()
                .run
                .is_some_and(|run| run.status == super::HostRunStatus::Running)
        {
            return Err(Error::Config("请先停止当前运行，再交还控制".into()));
        }
        if !resume {
            self.pause().await?;
        }
        let ui = inner
            .ui
            .as_ref()
            .ok_or_else(|| Error::Config("会话没有启用 UI 工具".into()))?;
        let result = ui
            .control(
                ToolContext {
                    call_id: format!("ui-control:{}", uuid::Uuid::new_v4()),
                    execution: ExecutionContext::new(
                        CancellationToken::new(),
                        Duration::from_secs(15),
                    )?,
                    session: inner.session.clone(),
                },
                backend,
                resume,
            )
            .await
            .map_err(|e| Error::ToolInfrastructure(e.to_string()));
        inner.state.notify();
        if resume
            && result
                .as_ref()
                .is_ok_and(|result| result["outcome"] == "executed")
        {
            self.resume_active();
        }
        result
    }
}
