//! 原生能力的模型输入与可信后台授权契约；原始系统句柄不跨进程传输。
use crate::ExecutionContext;
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 模型可请求的原生能力；恢复与授予后台控制不属于模型动作。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAction {
    /// 检查 OS 权限，不弹出或代替用户批准。
    Permissions,
    /// 枚举应用实例，不暴露安全输入值。
    Apps,
    /// 枚举所选应用的实际窗口。
    Windows,
    /// 有界读取窗口 AX 结构。
    Observe,
    /// 捕获目标窗口，并返回像素到屏幕的映射。
    Screenshot,
    /// 执行目标控件实际支持的 AX 动作。
    AxAction,
    /// 修改 AX 可写属性。
    SetValue,
    /// 请求可信宿主批准后台控制。
    RequestControl,
    /// 基于新鲜截图点击窗口位置。
    Pointer,
    /// 基于新鲜截图拖动，不跨调用保留按下状态。
    Drag,
    /// 在已授权后台窗口输入 Unicode 文本。
    Type,
    /// 发送有限的键盘组合。
    Key,
    /// 在已授权窗口滚动。
    Scroll,
    /// 主动交给用户，模型不能自行恢复。
    Handoff,
}

/// 有界原生输入；资源身份来自真实观察，字段不能改变宿主进程或 OS 权限。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ComputerInput {
    /// 已知原生动作。
    pub action: ComputerAction,
    /// 不透明应用实例身份，或唯一的 bundle identifier。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 256))]
    pub app: Option<String>,
    /// 窗口身份，不能由标题或位置猜测。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 256))]
    pub window: Option<String>,
    /// 当前观察身份。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 128))]
    pub observation: Option<String>,
    /// 当前观察中的控件引用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 128))]
    pub r#ref: Option<String>,
    /// 实际支持的 AX 动作名称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 128))]
    pub name: Option<String>,
    /// AXValue 的新字符串值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 65536))]
    pub value: Option<String>,
    /// Unicode 输入文字。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 65536))]
    pub text: Option<String>,
    /// 键盘组合，不接受任意执行代码。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 128))]
    pub key: Option<String>,
    /// 用户判断后台接管用途的原因。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 2000))]
    pub reason: Option<String>,
    /// 截图像素坐标或滚动量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    /// 截图像素坐标或滚动量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    /// 拖动起点横坐标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_x: Option<f64>,
    /// 拖动起点纵坐标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_y: Option<f64>,
    /// 拖动终点横坐标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_x: Option<f64>,
    /// 拖动终点纵坐标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_y: Option<f64>,
    /// left、right 或 middle。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<String>,
    /// 有界点击次数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 3))]
    pub clicks: Option<u32>,
}
impl ComputerInput {
    /// 在派发前核验动作所需的完整目标与参数；缺失或无效值不会触碰系统界面。
    pub fn validate(&self) -> Result<(), String> {
        let required = |value: &Option<String>, name: &str| {
            value
                .as_deref()
                .filter(|v| !v.is_empty())
                .map(|_| ())
                .ok_or_else(|| format!("原生动作缺少 {name}"))
        };
        match self.action {
            ComputerAction::Permissions | ComputerAction::Apps => return Ok(()),
            ComputerAction::Windows => return required(&self.app, "应用"),
            ComputerAction::Handoff => return Ok(()),
            _ => {
                required(&self.app, "应用")?;
                required(&self.window, "窗口")?;
            }
        }
        match self.action {
            ComputerAction::Observe | ComputerAction::Screenshot => {}
            ComputerAction::RequestControl => required(&self.reason, "接管用途")?,
            _ => required(&self.observation, "观察")?,
        }
        let coordinate = |value: Option<f64>, name: &str| {
            value
                .filter(|v| v.is_finite() && v.abs() <= 100000.0)
                .map(|_| ())
                .ok_or_else(|| format!("原生坐标 {name} 无效"))
        };
        match self.action {
            ComputerAction::AxAction => {
                required(&self.r#ref, "控件")?;
                required(&self.name, "AX 动作")?;
            }
            ComputerAction::SetValue => {
                required(&self.r#ref, "控件")?;
                if self.value.is_none() {
                    return Err("原生动作缺少值".into());
                }
            }
            ComputerAction::Type => {
                if self.text.is_none() {
                    return Err("原生动作缺少文字".into());
                }
            }
            ComputerAction::Key => required(&self.key, "按键")?,
            ComputerAction::Pointer | ComputerAction::Scroll => {
                coordinate(self.x, "x")?;
                coordinate(self.y, "y")?;
            }
            ComputerAction::Drag => {
                coordinate(self.from_x, "from_x")?;
                coordinate(self.from_y, "from_y")?;
                coordinate(self.to_x, "to_x")?;
                coordinate(self.to_y, "to_y")?;
            }
            _ => {}
        }
        if self
            .button
            .as_deref()
            .is_some_and(|v| !matches!(v, "left" | "right" | "middle"))
            || self.clicks.is_some_and(|v| !(1..=3).contains(&v))
        {
            return Err("原生鼠标参数无效".into());
        }
        Ok(())
    }
}

/// 后台授权绑定应用与窗口，不授予任意系统输入或审批界面访问。
#[derive(Clone, Debug, Serialize)]
pub struct UiAccessRequest {
    /// 应用实例。
    pub app: String,
    /// 本次接管的实际窗口。
    pub window: String,
    /// 模型明确说明的用途。
    pub reason: String,
    /// 从原生应用实例读取的可识别名称，不采用模型提供的标签。
    pub app_name: String,
    /// 从真实窗口读取的标题。
    pub window_title: String,
}
/// 只有可信宿主能够返回的后台控制决定。
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "decision",
    content = "details",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum UiAccessDecision {
    /// 在人工打断、交还或连接丢失前复用同一范围授权。
    AllowForSession,
    /// 拒绝接管并提供原因。
    Deny(String),
}
/// 原生后台接管审批边界；模型与外部页面不能提供决定。
#[async_trait]
pub trait UiApprover: Send + Sync {
    /// 在 context 的取消和截止时间内等待明确授权，通道故障不能当作允许。
    async fn approve(
        &self,
        request: UiAccessRequest,
        context: ExecutionContext,
    ) -> Result<UiAccessDecision, String>;
}
