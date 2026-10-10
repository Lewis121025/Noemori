use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn log_limit() -> u32 {
    50
}
#[path = "semantic.rs"]
mod semantic;
pub use semantic::*;

/// 显式观察的结果编码；增量仍以真实完整采集为依据。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObservationMode {
    /// 返回完整观察，保持既有调用行为。
    Full,
    /// 返回相对明确基线的变化，基线不足时返回完整观察。
    Delta,
}

/// 动作后观察策略；none 省掉采集并同时撤销旧引用和截图。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObservationPolicy {
    /// 采集并返回完整观察。
    Full,
    /// 采集后返回相对动作前观察的变化。
    Delta,
    /// 省略采集；后续引用动作必须显式重新观察。
    None,
}

/// 浏览器操作只携带会话内的页面与观察引用，不能选择浏览器进程、目录或调试端口。
/// 单次动作（含全部批量步骤）的 JSON 总量限 1 MiB；超限在派发前作为可纠正的输入错误拒绝。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(extend("type" = "object"))]
pub enum BrowserInput {
    /// 发现当前页面的真实后端能力，不支持的能力不列为可用。
    CapabilitiesList {
        /// 当前会话真实页面身份。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 按需读取实际支持能力的使用契约和预算。
    CapabilityGet {
        /// 当前会话真实页面身份。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 能力名称。
        name: crate::tool::ui::BrowserCapability,
    },
    /// 请求当前文档内的独立能力授权，网页元数据不能代替用户决定。
    RequestCapability {
        /// 当前会话真实页面身份。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 明确的能力范围。
        capability: crate::tool::ui::BrowserCapability,
        /// 用户需要判断的使用用途。
        #[schemars(length(min = 1, max = 2000))]
        reason: String,
    },
    /// 宿主读取审批准备状态，模型 Schema 不开放。
    #[schemars(skip)]
    ExtensionState {
        /// 当前会话真实页面身份。
        page: String,
    },
    /// 宿主审批后提交原始文档与目录身份，变化时后端拒绝授权。
    #[schemars(skip)]
    GrantCapability {
        /// 当前会话真实页面身份。
        page: String,
        /// 已审批的文档代次。
        document: String,
        /// 已审批的真实网站来源。
        origin: String,
        /// 审批准备时的工具目录版本。
        revision: String,
        /// 已审批的独立能力。
        capability: crate::tool::ui::BrowserCapability,
    },
    /// 增量读取当前文档的有界开发日志，需独立能力批准。
    DeveloperLogs {
        /// 当前页面。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 上次返回的日志序号。
        #[serde(default)]
        after: u32,
        /// 单次最多一百项，输出另受字节预算限制。
        #[serde(default = "log_limit")]
        #[schemars(range(min = 1, max = 100))]
        limit: u32,
    },
    /// 发现浏览器登记的当前主文档 WebMCP 工具及输入 Schema。
    WebmcpList {
        /// 当前页面。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 在已批准能力内调用一次工具，旧目录与 Schema 错误不会派发。
    WebmcpCall {
        /// 当前页面。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 最近发现返回的目录代次。
        #[schemars(length(min = 1, max = 128))]
        directory: String,
        /// 同一目录内的不透明工具身份。
        #[schemars(length(min = 1, max = 128))]
        tool: String,
        /// 与工具 Schema 一致的有界 JSON 对象。
        input: serde_json::Map<String, serde_json::Value>,
        /// 工具动作后的观察策略，省略返回完整观察。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
    },
    /// 读取当前页面的固定 CDP 诊断方法，不授予脚本、网络、文件或其他目标权限。
    CdpSend {
        /// 当前页面。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// capability_get(cdp) 返回的精确只读方法。
        #[schemars(length(min = 1, max = 100))]
        method: String,
        /// 精确方法参数，额外目标字段会被拒绝。
        params: serde_json::Map<String, serde_json::Value>,
    },
    /// 可信宿主准备一次性 WebMCP 调用，模型不能跳过输入 Schema 验证。
    #[schemars(skip)]
    WebmcpPrepare {
        /// 当前页面。
        page: String,
        /// 已发现目录。
        directory: String,
        /// 同目录工具身份。
        tool: String,
        /// 后端将冻结的实际输入。
        input: serde_json::Map<String, serde_json::Value>,
    },
    /// 宿主验证输入后消费一次性准备身份，不允许自动重放。
    #[schemars(skip)]
    WebmcpInvoke {
        /// 当前页面。
        page: String,
        /// 当前目录内仅可消费一次的准备身份。
        prepared: String,
        /// 宿主沿用调用者选择的动作后观察策略。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
    },
    /// 当前语义查询只解析一次，唯一目标绑定真实节点后执行，禁止自动重放未知副作用。
    Locator {
        /// 当前会话内的真实页面身份。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 有界作用域与 iframe 语义查询。
        locator: BrowserLocator,
        /// 固定读取或交互原语。
        operation: BrowserLocatorOperation,
        /// fill 的替换文字。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(length(max = 65536))]
        text: Option<String>,
        /// press 的键盘组合。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(length(min = 1, max = 100))]
        key: Option<String>,
        /// select 的目标选项。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(length(max = 50))]
        values: Option<Vec<String>>,
        /// select 的匹配依据，省略时按标签。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<SelectionBy>,
        /// check 的明确目标状态。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked: Option<bool>,
        /// 动作后返回完整、增量或省略观察。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
    },
    /// 用户地址栏和标签页操作；不向模型开放，不依赖失效的控件观察。
    #[schemars(skip)]
    HumanNavigate {
        /// 已校验的用户导航动作。
        command: BrowserNavigation,
    },
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
        /// 目标绝对 URL。
        #[schemars(length(min = 1, max = 8192))]
        url: String,
    },
    /// 导航已有标签页，导航使旧观察失效。
    Navigate {
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
        /// 宿主返回的页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
        /// 目标绝对 URL。
        #[schemars(length(min = 1, max = 8192))]
        url: String,
    },
    /// 后退到上一历史记录。
    Back {
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 前进到下一历史记录。
    Forward {
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
        /// 页面标识。
        #[schemars(length(min = 1, max = 128))]
        page: String,
    },
    /// 刷新页面，不能用于盲目重试提交。
    Reload {
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 默认完整观察；增量模式仅相对调用者明确保留的基线。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<ObservationMode>,
        /// 增量基线；缺失、失效或不匹配时明确回退完整观察。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(length(min = 1, max = 128))]
        baseline: Option<String>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
        /// 动作后的观察策略；省略时采集完整证据，none 撤销旧引用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_mode: Option<ObservationPolicy>,
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
    /// 请求用户协助；专用浏览器必须给出完成条件，系统观察成功证据后自动继续。
    Handoff {
        /// 专用浏览器使用；外接浏览器仍由其可信界面交还控制。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion: Option<BrowserHandoffRequest>,
    },
    /// 可信宿主主动接管；模型不能用无条件接管制造无法自动结束的协助。
    #[schemars(skip)]
    Takeover,
    /// 用户交还后使旧观察失效，后续必须重新观察。
    #[schemars(skip)]
    Resume,
}

/// 可信浏览器工具栏的有限导航契约，禁止传入脚本、权限或模型工具动作。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserNavigation {
    /// 新建用户标签页。
    Open {
        /// 用户选定的目标网页地址，由导航入口校验。
        url: String,
    },
    /// 导航用户选中的标签页。
    Navigate {
        /// 当前会话拥有且由用户选中的标签页标识。
        page: String,
        /// 用户选定的目标网页地址，由导航入口校验。
        url: String,
    },
    /// 后退到上一条浏览历史。
    Back {
        /// 当前会话拥有且由用户选中的标签页标识。
        page: String,
    },
    /// 前进到下一条浏览历史。
    Forward {
        /// 当前会话拥有且由用户选中的标签页标识。
        page: String,
    },
    /// 刷新当前网页。
    Reload {
        /// 当前会话拥有且由用户选中的标签页标识。
        page: String,
    },
    /// 关闭选中的标签页。
    Close {
        /// 当前会话拥有且由用户选中的标签页标识。
        page: String,
    },
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
        /// 人工鼠标按钮；省略时使用主按钮。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        button: Option<String>,
        /// 当前 click 的连续点击编号，限制为一至三；每条输入只派发一次按下和释放。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clicks: Option<u32>,
    },
    /// 在同一截图映射内拖动，控件或窗口失效时停止。
    Drag {
        /// 起始横坐标。
        from_x: f64,
        /// 起始纵坐标。
        from_y: f64,
        /// 结束横坐标。
        to_x: f64,
        /// 结束纵坐标。
        to_y: f64,
    },
    /// 在当前页面滚动。
    Scroll {
        /// 水平滚动量。
        x: f64,
        /// 垂直滚动量。
        y: f64,
        /// 人工滚动所在的截图横坐标。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at_x: Option<f64>,
        /// 人工滚动所在的截图纵坐标。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at_y: Option<f64>,
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
    /// 桌面内嵌网页视图身份；独立 Chromium 不提供此字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_target: Option<String>,
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
    /// 独立于界面可见性的协助进展；旧存档和未协助状态为空。
    pub handoff: Option<BrowserHandoffState>,
    /// 当前标签页。
    pub tabs: Vec<BrowserTab>,
    /// 最近操作回执，最多保留 32 条。
    pub receipts: Vec<BrowserReceipt>,
    /// 不可恢复故障。
    pub error: Option<String>,
}

/// 浏览器会话生命周期；协助条件结算后由可信宿主交还，模型不能自行恢复。
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

/// 自动协助绑定真实页面与不可变的正向成功条件。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserHandoffRequest {
    /// 当前会话页面身份。
    #[schemars(length(min = 1, max = 128))]
    pub page: String,
    /// 具体业务的成功证据，不允许用空闲、任意跳转或控件消失代替。
    pub until: BrowserHandoffCondition,
}

/// 系统只做只读判断，不在用户操作期间执行模型输入。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserHandoffCondition {
    /// 完成后的精确 HTTP(S) 地址，必须等待文档加载结束。
    Url {
        /// 不包含凭据的绝对地址。
        #[schemars(length(min = 1, max = 8192))]
        url: String,
    },
    /// 当前页面或子框架可见的精确成功文字。
    Text {
        /// 明确表示业务成功的提示。
        #[schemars(length(min = 1, max = 4096))]
        text: String,
    },
}

/// 协助身份与结算结果由浏览器运行时产生，不接受网页写入。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserHandoffState {
    /// 本次协助的唯一身份。
    pub id: String,
    /// 原始协助目标，登录弹窗关闭后仍可回到此页。
    pub page: String,
    /// 完成、失败和取消分别保留，不把异常当成业务成功。
    pub status: BrowserHandoffStatus,
    /// 失败时可用于重新规划的真实原因。
    pub error: Option<String>,
}

/// 协助状态只沿等待到终态流转，新请求使用新身份。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserHandoffStatus {
    /// 用户仍在处理网页。
    Waiting,
    /// 预先声明的成功证据稳定满足。
    Completed,
    /// 页面关闭、崩溃或观察失败。
    Failed,
    /// 任务取消或用户通过其他可信入口交还。
    Cancelled,
}
