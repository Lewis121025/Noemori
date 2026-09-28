//! 链接记录与种类。

/// 链接语法种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// `[[target]]` 或 `[[target|alias]]`。
    Wiki,
    /// Markdown 内联地址或引用定义，包含图片目标。
    Markdown,
}

impl LinkKind {
    /// `SQLite` 存储用的稳定字符串。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wiki => "wiki",
            Self::Markdown => "md",
        }
    }
}

impl std::str::FromStr for LinkKind {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "wiki" => Ok(Self::Wiki),
            "md" => Ok(Self::Markdown),
            _ => Err(()),
        }
    }
}

/// 索引里一条链接的解析状态。
///
/// `to_path` 只在 [`LinkResolution::Resolved`] 时有值。歧义、死链和纯锚点
/// 都不是图边，但出链面板要能直接区分，不能等点击后再解析。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkResolution {
    /// 唯一命中。
    Resolved,
    /// 同名多候选。
    Ambiguous,
    /// 没有任何候选。
    Dead,
    /// 纯锚点，指向源文件自身，不写入 `to_path`。
    SelfAnchor,
}

impl LinkResolution {
    /// `SQLite` 与 IPC 用的稳定字符串。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Resolved => "resolved",
            Self::Ambiguous => "ambiguous",
            Self::Dead => "dead",
            Self::SelfAnchor => "self",
        }
    }
}

impl std::str::FromStr for LinkResolution {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "resolved" => Ok(Self::Resolved),
            "ambiguous" => Ok(Self::Ambiguous),
            "dead" => Ok(Self::Dead),
            "self" => Ok(Self::SelfAnchor),
            _ => Err(()),
        }
    }
}

/// 索引中的一条出链/入链。
///
/// `start_byte`/`end_byte` 指向源文件 UTF-8 字节区间，供改名时按区间替换。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRecord {
    /// 源文件库内相对路径。
    pub from_path: String,
    /// 链接原文中的目标（wiki 为 target，md 为 url）。
    pub to_raw: String,
    /// 唯一解析到的库内路径；歧义、死链和纯锚点为 `None`。
    pub to_path: Option<String>,
    /// 语法种类。
    pub kind: LinkKind,
    /// 区间起点（含）。
    pub start_byte: i64,
    /// 区间终点（不含）。
    pub end_byte: i64,
    /// 索引解析状态，与 `to_path` 一起写入。
    pub resolution: LinkResolution,
}

/// 从链接目标里分出资源路径与 `?`/`#` 后缀。
///
/// 解析只认路径；改写必须把后缀拼回原文，否则锚点会丢。
#[must_use]
pub(crate) fn split_resource(raw: &str) -> (&str, &str) {
    match raw.find(['?', '#']) {
        Some(index) => raw.split_at(index),
        None => (raw, ""),
    }
}

/// 链接解析结果：资源路径与 `#` 锚点分开返回，歧义交给界面选择。
///
/// 图边（`links.to_path`）只接受唯一解析；本类型服务交互式跳转，
/// 因此歧义候选与锚点都要带出去。索引行另用 [`LinkResolution`] 记下死链与歧义。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    /// 唯一命中；`path` 是库内相对路径，纯锚点链接指回源文件自身。
    Resolved {
        /// 目标库内相对路径。
        path: String,
        /// 已解码的标题锚点；无锚点为 `None`。
        anchor: Option<String>,
    },
    /// 同名多候选；候选按路径升序，界面必须让用户选择而不是静默取一。
    Ambiguous {
        /// 候选库内相对路径。
        candidates: Vec<String>,
        /// 已解码的标题锚点，选择后继续生效。
        anchor: Option<String>,
    },
    /// 没有任何候选。
    Dead,
}

/// 从资源后缀提取标题锚点。
///
/// 后缀来自 [`split_resource`]：`""`、`?query`、`#frag` 或 `?query#frag`。
/// Markdown 链接的锚点按 URL 规则百分号解码；wiki 目标在扫描期已做实体
/// 解码，此处保持原文，避免二次解码把字面 `%` 破坏。空片段视为无锚点。
#[must_use]
pub(crate) fn anchor_of(suffix: &str, kind: LinkKind) -> Option<String> {
    let fragment = suffix
        .strip_prefix('#')
        .or_else(|| suffix.split_once('#').map(|(_, rest)| rest))?;
    let text = match kind {
        LinkKind::Markdown => percent_encoding::percent_decode_str(fragment)
            .decode_utf8()
            .map_or_else(|_| fragment.to_string(), std::borrow::Cow::into_owned),
        LinkKind::Wiki => fragment.to_string(),
    };
    (!text.is_empty()).then_some(text)
}
