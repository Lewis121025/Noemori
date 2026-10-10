//! 应用启动先解析真实安装身份，再等待可信批准；批准不穿过安装身份变化或人工接管。
use super::{
    UiTool,
    computer::{UiLaunchDecision, UiLaunchRequest},
};
use crate::{
    Image,
    tool::{ToolContext, ToolError},
};
use serde_json::{Value, json};

impl UiTool {
    pub(super) async fn request_launch(
        &self,
        value: &Value,
        context: &ToolContext,
    ) -> Result<(Value, Option<Image>), ToolError> {
        self.check_launch_control(context)?;
        let approver = self
            .launch_approver
            .as_ref()
            .ok_or_else(|| ToolError::Execution("宿主未提供应用启动审批".into()))?;
        let bundle = value
            .get("bundle_id")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Execution("启动应用缺少标识".into()))?;
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| ToolError::Execution("请说明启动应用的用途".into()))?;
        let request = json!({"action":"launch_info","bundle_id":bundle});
        let (current, _) = self.remote("computer", request.clone(), context).await?;
        if current.get("error").is_some() {
            return Ok((current, None));
        }
        let name = launch_name(&current, bundle)?;
        match approver
            .approve(
                UiLaunchRequest {
                    bundle_id: bundle.into(),
                    app_name: name.into(),
                    reason: reason.into(),
                },
                context.execution.clone(),
            )
            .await
            .map_err(ToolError::Execution)?
        {
            UiLaunchDecision::AllowOnce => {}
            UiLaunchDecision::Deny(reason) => {
                return Err(ToolError::Execution(format!("应用启动被拒绝：{reason}")));
            }
        }
        self.check_launch_control(context)?;
        let (latest, _) = self.remote("computer", request, context).await?;
        if launch_name(&latest, bundle)? != name {
            return Err(ToolError::Execution(
                "审批期间应用安装身份已变化，请重新申请".into(),
            ));
        }
        self.remote(
            "computer",
            json!({"action":"launch_app","bundle_id":bundle}),
            context,
        )
        .await
    }

    fn check_launch_control(&self, context: &ToolContext) -> Result<(), ToolError> {
        context
            .execution
            .check()
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        if self
            .connections
            .as_ref()
            .is_some_and(|config| config.broker.paused(context.session.id(), "computer"))
        {
            return Err(ToolError::Execution(
                "用户持有控制权，请先从可信界面交还".into(),
            ));
        }
        Ok(())
    }
}

fn launch_name<'a>(value: &'a Value, bundle: &str) -> Result<&'a str, ToolError> {
    if value["outcome"] != "observed" || value["bundle_id"] != bundle {
        return Err(ToolError::Execution(
            "系统未确认待启动应用的安装身份".into(),
        ));
    }
    value
        .get("app_name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ToolError::Execution("待启动应用缺少系统显示名称".into()))
}
