//! 结构化语义查询的公共契约；不接受原始 CSS、页面脚本或按位置选择。
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// iframe 路径逐级唯一解析，最终链在该文档内执行；后端再次限制嵌套和总节点预算。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserLocator {
    /// 作用域查询链，前一匹配的后代成为下一查询的范围。
    #[schemars(length(min = 1, max = 8))]
    pub chain: Vec<BrowserSemanticQuery>,
    /// 每一级 iframe 的唯一查询链，省略时只查询主文档。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 8))]
    pub frames: Vec<Vec<BrowserSemanticQuery>>,
    /// 真实观察中的完整框架 URL，当前集合必须严格唯一；逐级路径随后从此框架内开始。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 8192))]
    pub frame_url: Option<String>,
}

/// 语义查询类别只对应固定引擎的内置功能，不能注册自定义执行代码。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrowserSemanticKind {
    /// 可访问角色与可选名称。
    Role,
    /// 关联标签或可访问标签。
    Label,
    /// 元素的规范化文字。
    Text,
    /// 输入框占位文字。
    Placeholder,
    /// 明确的 data-testid 标识。
    TestId,
}

/// 单步查询保存明确的匹配模式，名字只适用于角色查询。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserSemanticQuery {
    /// 固定语义查询种类。
    pub kind: BrowserSemanticKind,
    /// 角色名称或查询文字。
    #[schemars(length(min = 1, max = 4096))]
    pub value: String,
    /// 角色的可访问名称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 4096))]
    pub name: Option<String>,
    /// 默认精确匹配；false 使用引擎规范化的包含匹配。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exact: Option<bool>,
    /// 相对于该候选元素的附加条件。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<BrowserSemanticFilter>,
}

/// 后代查询必须属于同一 frame，不支持通过过滤切换页面或框架。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserSemanticFilter {
    /// 候选元素必须包含的文字。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 4096))]
    pub has_text: Option<String>,
    /// 候选元素不得包含的文字。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 4096))]
    pub has_not_text: Option<String>,
    /// 必须含有符合此查询链的后代。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 8))]
    pub has: Option<Vec<BrowserSemanticQuery>>,
    /// 不得含有符合此查询链的后代。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 8))]
    pub has_not: Option<Vec<BrowserSemanticQuery>>,
    /// 明确过滤可见或隐藏元素。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
}

/// count 为允许歧义的只读计数，其余读取和动作都必须唯一。
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrowserLocatorOperation {
    /// 点击唯一目标。
    Click,
    /// 移入唯一目标。
    Hover,
    /// 替换输入内容。
    Fill,
    /// 选择下拉框选项。
    Select,
    /// 设置明确的勾选状态。
    Check,
    /// 在目标内发送受支持键盘组合。
    Press,
    /// 读取有界文本、固定属性和控件状态，屏蔽安全输入值。
    Inspect,
    /// 只读计算当前匹配数量。
    Count,
}
