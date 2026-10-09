use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 浏览器操作只携带会话内的页面与观察引用，不能选择浏览器进程、目录或调试端口。
/// 单次动作（含全部批量步骤）的 JSON 总量限 1 MiB；超限在派发前作为可纠正的输入错误拒绝。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(extend("type" = "object"))]
pub enum BrowserInput {
    /// 可信预览界面只读取画面，不改变模型观察或控制权。
    #[schemars(skip)]
    Preview {
        /// 当前会话已有页面。
        page: String,
    },
    /// 可信界面在人工接管后转发输入，模型 Schema 不提供此入口。
    #[schemars(skip)]
    HumanInput {
        /// 当前会话已有页面。
        page: String,
        /// 最近预览授予的人工输入凭据，接管或页面改变后失效。
        token: String,
        /// 有界人工输入。
        input: BrowserHumanInput,
    },
    /// 对同一稳定观察中的表单控件顺序执行；任一步失败或页面改变时停止，不回滚或重放。
    Batch {
        /// 当前页面。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 所有步骤共享的初始观察，执行前逐步核验真实节点。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 明确的控件动作，不能包含导航、权限或脚本执行。
        #[schemars(length(min = 1, max = 16))]
        steps: Vec<BrowserStep>,
    },
    /// 请求访问本机或内网来源，必须由用户批准后才能生效。
    RequestAccess {
        /// 精确来源，例如 http://localhost:3000，不含路径。
        #[schemars(length(min = 1, max = 8192))]
        origin: String,
        /// 明确说明访问用途。
        #[schemars(length(min = 1, max = 2000))]
        reason: String,
    },
    /// 只由宿主在审批完成后发送，不向模型开放。
    #[schemars(skip)]
    AllowOrigin {
        /// 已批准的完整来源。
        origin: String,
    },
    /// 枚举本会话标签页及待处理对话框。
    Tabs,
    /// 新建标签页并打开公开 HTTP(S) 页面。
    Open {
        /// 目标绝对 URL。
        #[schemars(length(min = 1, max = 8192))]
        url: String,
    },
    /// 导航已有标签页，导航使旧观察失效。
    Navigate {
        /// 宿主返回的页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 目标绝对 URL。
        #[schemars(length(min = 1, max = 8192))]
        url: String,
    },
    /// 后退到上一历史记录。
    Back {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 前进到下一历史记录。
    Forward {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 刷新页面，不能用于盲目重试提交。
    Reload {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 关闭指定标签页。
    Close {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 获取当前页面结构及本次有效的控件引用。
    Observe {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 读取页面可访问内容，截断时明确说明。
    Read {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// Unicode 字符偏移；长页面按 next_offset 继续读取。
        #[serde(default)]
        #[schemars(range(max = 10000000))]
        offset: u32,
    },
    /// 查找唯一文字并滚动到对应位置，再生成可操作观察。
    Find {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 唯一目标文字。
        #[schemars(length(min = 1, max = 4096))]
        text: String,
        /// 默认精确匹配，避免命中说明文字；需要包含匹配时明确设为 false。
        #[serde(default = "exact_match")]
        exact: bool,
    },
    /// 填写由页面按钮打开的文件选择器；文件必须在授权工作区内。
    ChooseFiles {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 相对工作区的文件路径，空数组取消选择。
        #[schemars(length(max = 50))]
        paths: Vec<String>,
    },
    /// 返回视口截图和对应观察，供视觉定位。
    Screenshot {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 点击观察中的真实控件，失效引用不会重新定位其他节点。
    Click {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 最新观察标识。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 观察中的控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
    },
    /// 悬停并观察展开内容。
    Hover {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 最新观察标识。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
    },
    /// 替换输入框内容。
    Fill {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 最新观察标识。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
        /// 输入文本。
        #[schemars(length(max = 65536))]
        text: String,
    },
    /// 默认按可见标签选择原生下拉框，选择属性值时必须明确指定模式。
    Select {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 最新观察标识。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
        /// 目标标签，或 by=value 时的选项属性值。
        #[schemars(length(max = 50))]
        values: Vec<String>,
        /// 默认 label，避免标签碰巧等于另一选项的属性值时选错。
        #[serde(default)]
        by: SelectionBy,
    },
    /// 将复选框设置为明确状态，避免重试切换产生相反效果。
    Check {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 最新观察标识。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
        /// 期望状态。
        checked: bool,
    },
    /// 按键盘语义逐字符输入，不替换已有内容；用于需要按键事件的编辑器或当前焦点。
    Type {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 当前观察。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 可选目标控件，省略时使用该页面当前焦点。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        /// 在当前插入点输入的文本。
        #[schemars(length(min = 1, max = 16384))]
        text: String,
    },
    /// 向控件或当前焦点发送按键组合。
    Press {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 最新观察标识。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 可选目标，缺省使用当前焦点。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        /// Playwright 按键名称。
        #[schemars(length(min = 1, max = 100))]
        key: String,
    },
    /// 滚动视口并重新观察。
    Scroll {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 最新观察标识。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 水平滚动 CSS 像素。
        #[schemars(range(min = -10000, max = 10000))]
        x: i32,
        /// 垂直滚动 CSS 像素。
        #[schemars(range(min = -10000, max = 10000))]
        y: i32,
    },
    /// 根据未改变的截图执行坐标点击。
    Pointer {
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// screenshot 返回的观察标识。
        #[schemars(length(min = 1, max = 128))]
        observation: String,
        /// 水平坐标。
        #[schemars(range(max = 4096))]
        x: u32,
        /// 垂直坐标。
        #[schemars(range(max = 4096))]
        y: u32,
        /// 鼠标按键。
        button: MouseButton,
        /// 单击或双击。
        #[schemars(range(min = 1, max = 2))]
        clicks: u8,
    },
    /// 根据当前截图执行拖拽，取消时仍释放鼠标按键。
    Drag {
        /// 页面标识。
        page: String,
        /// screenshot 返回的观察标识。
        observation: String,
        /// 起点水平坐标。
        #[schemars(range(max = 4096))]
        from_x: u32,
        /// 起点垂直坐标。
        #[schemars(range(max = 4096))]
        from_y: u32,
        /// 终点水平坐标。
        #[schemars(range(max = 4096))]
        to_x: u32,
        /// 终点垂直坐标。
        #[schemars(range(max = 4096))]
        to_y: u32,
    },
    /// 等待页面文字满足条件，不依赖固定睡眠或无限 networkidle。
    Wait {
        /// 页面标识。
        page: String,
        /// 目标文字。
        #[schemars(length(min = 1, max = 4096))]
        text: String,
        /// 期望可见性。
        state: WaitState,
        /// 默认精确匹配，所有同名可见目标均消失后才认定 hidden。
        #[serde(default = "exact_match")]
        exact: bool,
    },
    /// 明确接受或取消 JavaScript 对话框。
    Dialog {
        /// 页面标识。
        page: String,
        /// 是否接受。
        accept: bool,
        /// prompt 对话框的可选输入。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    /// 将授权工作区内的普通文件上传到已观察的文件输入框。
    Upload {
        /// 页面标识。
        page: String,
        /// 最新观察标识。
        observation: String,
        /// 文件输入框引用。
        r#ref: String,
        /// 相对工作区的文件路径。
        #[schemars(length(max = 50))]
        paths: Vec<String>,
    },
    /// 查看下载的真实完成状态。
    Downloads,
    /// 在明确操作前登记当前页面的下载集合，不触发新的网络请求。
    ArmDownload {
        /// 实际页面身份。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 等待当前页面自登记后产生的下载结算，不重新触发页面动作。
    AwaitDownload {
        /// 与登记相同的页面身份。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 关联原生操作后由宿主使所有页面观察失效，模型不可直接构造此动作。
    #[schemars(skip)]
    Invalidate,
    /// 将已完成下载保存到工作区；目标存在时拒绝覆盖。
    SaveDownload {
        /// 下载标识。
        id: String,
        /// 相对工作区的目标路径。
        path: String,
    },
    /// 交给用户操作，后续 Agent 动作暂停。
    Handoff,
    /// 用户交还后使旧观察失效，后续必须重新观察。
    #[schemars(skip)]
    Resume,
}

/// 预览窗口的人工输入；运行时再次核验控制者和页面尺寸，拒绝未知字段。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserHumanInput {
    /// 用户处理网页的确认或输入对话框。
    Dialog {
        /// 是否确认。
        accept: bool,
        /// prompt 的输入内容。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    /// 用户在系统文件选择器选中的文件仍须属于已授权工作区。
    Files {
        /// 经过可信界面选择的路径。
        paths: Vec<String>,
    },
    /// 在截图的 CSS 像素坐标单击。
    Pointer {
        /// 截图横坐标。
        x: f64,
        /// 截图纵坐标。
        y: f64,
    },
    /// 在当前页面滚动。
    Scroll {
        /// 水平滚动量。
        x: f64,
        /// 垂直滚动量。
        y: f64,
    },
    /// 发送受浏览器支持的按键组合。
    Key {
        /// 浏览器按键名称。
        key: String,
    },
    /// 输入完整文本，包括中文输入法提交。
    Text {
        /// 待输入文本。
        text: String,
    },
}

impl BrowserInput {
    /// 字段各自合法不代表聚合后仍在运行预算内；派发和审批前核验序列化总量。
    /// 不访问浏览器；编码失败或超过总量预算时返回可纠正的 ToolError::Execution。
    pub(super) fn validate_payload(&self) -> Result<(), super::ToolError> {
        let bytes = serde_json::to_vec(self)
            .map_err(|error| super::ToolError::Execution(format!("浏览器动作无法编码：{error}")))?;
        if bytes.len() > 1024 * 1024 {
            return Err(super::ToolError::Execution(
                "浏览器动作 JSON 超过 1 MiB，请拆分批量步骤或缩短输入".into(),
            ));
        }
        Ok(())
    }
}

fn exact_match() -> bool {
    true
}

/// 批量操作的单个控件步骤，复用单步执行器的节点校验与行为。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserStep {
    /// 点击已观察控件。
    Click {
        /// 控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
    },
    /// 替换文本字段。
    Fill {
        /// 控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
        /// 目标内容。
        #[schemars(length(max = 65536))]
        text: String,
    },
    /// 选择下拉框选项。
    Select {
        /// 控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
        /// 默认标签，或 by=value 时的选项属性值。
        #[schemars(length(max = 50))]
        values: Vec<String>,
        /// 明确的选择模式，默认 label。
        #[serde(default)]
        by: SelectionBy,
    },
    /// 设置复选框的明确状态。
    Check {
        /// 控件引用。
        #[schemars(length(min = 1, max = 128))]
        r#ref: String,
        /// 目标状态。
        checked: bool,
    },
}

/// 批量步骤的实际执行事实；缺少回执的后续步骤没有执行。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserStepReceipt {
    /// 从零开始的步骤序号。
    pub index: usize,
    /// 动作名称。
    pub action: String,
    /// 已执行、未执行或副作用未知。
    pub outcome: BrowserOutcome,
    /// 具体失败原因。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 选择依据明确分离，不能同时猜测标签和隐藏的属性值。
#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SelectionBy {
    /// 用户可见标签。
    #[default]
    Label,
    /// 已知的 option.value 属性。
    Value,
}

/// 鼠标按键使用受支持的固定集合。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    /// 左键。
    Left,
    /// 右键。
    Right,
    /// 中键。
    Middle,
}

/// 等待条件由实际页面可见性决定。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WaitState {
    /// 目标可见。
    Visible,
    /// 目标隐藏或不存在。
    Hidden,
}

/// 浏览器回执记录实际动作阶段；未知副作用不能按未执行处理。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserOutcome {
    /// 只读观察已返回。
    Observed,
    /// 动作已执行，但业务完成仍需检查观察。
    Executed,
    /// 动作尚未派发。
    NotExecuted,
    /// 动作可能生效，禁止自动重放。
    Unknown,
}

/// 保留取消后迟到的动作结算，下一轮与界面都可以检查。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserReceipt {
    /// 批量动作在取消后也保留各步骤的结算。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<BrowserStepReceipt>,
    /// 原工具调用标识。
    pub call_id: String,
    /// 本次动作。
    pub action: String,
    /// 真实执行阶段。
    pub outcome: BrowserOutcome,
    /// 失败原因。
    pub error: Option<String>,
}

/// 界面可见标签页，不包含调试端口或认证材料。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserTab {
    /// 页面是否正在等待文件选择。
    pub file_chooser: bool,
    /// 不透明页面标识。
    pub id: String,
    /// 当前地址。
    pub url: String,
    /// 最近观察到的标题。
    pub title: String,
    /// 页面进程是否崩溃。
    pub crashed: bool,
    /// 待处理对话框。
    pub dialog: Option<BrowserDialog>,
}

/// 网站弹窗只提供种类与提示，不由运行时自动接受。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserDialog {
    /// 浏览器对话框类型。
    pub r#type: String,
    /// 提示正文。
    pub message: String,
}

/// 浏览器宿主状态与模型历史独立，运行取消不会丢失迟到结果。
#[derive(Clone, Debug, Default, Serialize)]
pub struct BrowserSnapshot {
    /// 资源状态。
    pub status: BrowserStatus,
    /// 当前标签页。
    pub tabs: Vec<BrowserTab>,
    /// 最近操作回执，最多保留 32 条。
    pub receipts: Vec<BrowserReceipt>,
    /// 不可恢复故障。
    pub error: Option<String>,
}

/// 浏览器会话生命周期；关闭是永久终态，人工控制必须显式交还。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserStatus {
    /// 尚未启动。
    #[default]
    Idle,
    /// 正在创建进程与控制连接。
    Starting,
    /// 可接受命令。
    Ready,
    /// 命令仍在结算。
    Busy,
    /// 人工持有控制权。
    Human,
    /// 基础设施故障，旧页面已失效。
    Failed,
    /// 资源已经关闭。
    Closed,
}
