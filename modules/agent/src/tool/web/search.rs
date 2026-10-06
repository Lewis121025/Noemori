//! 搜索页面只在适配边界解析，空结果与未知页面结构严格区分。

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use scraper::{Html, Selector};
use serde::Serialize;
use std::{collections::BTreeMap, fmt};

/// 第一版明确支持的免费公开搜索源。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchEngine {
    /// Bing 公开搜索页面。
    Bing,
    /// DuckDuckGo HTML 搜索页面。
    Duckduckgo,
}

impl fmt::Display for SearchEngine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Bing => "Bing",
            Self::Duckduckgo => "DuckDuckGo",
        })
    }
}

/// 模型需要的最小搜索观察，不附加内部追踪字段。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SearchResult {
    /// 搜索结果标题。
    pub title: String,
    /// 搜索引擎原始摘要，不能视为已核实的全文。
    pub summary: String,
    /// 已解开搜索引擎跳转包装的目标链接。
    pub url: String,
}

/// 搜索源失败或完整性受影响时，必须反馈的来源及具体原因。
#[derive(Clone, Debug, Serialize)]
pub struct SearchWarning {
    /// 产生失败或完整性说明的搜索源。
    pub source: SearchEngine,
    /// 明确的失败或结果完整性说明。
    pub reason: String,
}

/// 一个源的结果与完整性说明；成功源的警告不能在合并时被丢弃。
pub(super) struct SearchBatch {
    pub results: Vec<SearchResult>,
    pub warnings: Vec<String>,
}

/// 为已校验的 `query` 构造指定 `engine` 的公开检索 URL，编码关键词防止改变请求结构。
pub(super) fn search_url(engine: SearchEngine, query: &str) -> String {
    let base = match engine {
        SearchEngine::Bing => "https://www.bing.com/search",
        SearchEngine::Duckduckgo => "https://html.duckduckgo.com/html/",
    };
    let mut url = Url::parse(base).expect("固定搜索 URL 必须有效");
    url.query_pairs_mut().append_pair("q", query);
    url.to_string()
}

fn selector(value: &str) -> Selector {
    Selector::parse(value).expect("固定选择器必须有效")
}
fn text(element: scraper::ElementRef<'_>) -> String {
    element
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 解析公开搜索页并校验目标链接；验证码或结构变化必须返回错误。
///
/// `html` 是完整的有界响应；返回按源排序的标题、摘要及 URL。
/// # 错误
/// 验证页、失效链接或无法识别的页面返回明确原因；已识别的空结果返回空列表。
pub fn parse_search_page(engine: SearchEngine, html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);
    if document
        .select(&selector(
            "form#challenge-form, #captcha, .captcha, #b_captcha",
        ))
        .next()
        .is_some()
        || html.contains("Verify you are human")
        || html.contains("unusual traffic")
    {
        return Err("搜索源要求验证码或人机验证，无法读取结果".into());
    }
    let (rows, links, snippets, empty) = match engine {
        SearchEngine::Bing => ("li.b_algo", "h2 a[href]", ".b_caption p, p", ".b_no"),
        SearchEngine::Duckduckgo => (
            ".result",
            "a.result__a[href]",
            ".result__snippet",
            ".no-results",
        ),
    };
    let mut results = Vec::new();
    for row in document.select(&selector(rows)) {
        let Some(link) = row.select(&selector(links)).next() else {
            continue;
        };
        let title = text(link);
        let summary = row
            .select(&selector(snippets))
            .next()
            .map(text)
            .unwrap_or_default();
        let url = target_url(engine, link.value().attr("href").unwrap_or_default())?;
        if !title.is_empty() {
            results.push(SearchResult {
                title,
                summary,
                url,
            });
        }
    }
    if results.is_empty() && document.select(&selector(empty)).next().is_none() {
        return Err("未识别到搜索结果或空结果标记，搜索页面结构可能已变化".into());
    }
    Ok(results)
}

fn target_url(engine: SearchEngine, href: &str) -> Result<String, String> {
    let base = match engine {
        SearchEngine::Bing => "https://www.bing.com",
        SearchEngine::Duckduckgo => "https://duckduckgo.com",
    };
    let url = Url::parse(base)
        .expect("固定源 URL 有效")
        .join(href)
        .map_err(|_| "搜索结果 URL 无效")?;
    let target = match engine {
        SearchEngine::Duckduckgo
            if url
                .host_str()
                .is_some_and(|host| host.ends_with("duckduckgo.com")) =>
        {
            url.query_pairs()
                .find(|(key, _)| key == "uddg")
                .map(|(_, value)| value.into_owned())
        }
        SearchEngine::Bing if url.host_str() == Some("www.bing.com") && url.path() == "/ck/a" => {
            url.query_pairs()
                .find(|(key, _)| key == "u")
                .and_then(|(_, value)| value.strip_prefix("a1").map(str::to_owned))
                .map(|encoded| {
                    URL_SAFE_NO_PAD
                        .decode(encoded)
                        .map_err(|_| "Bing 跳转 URL 编码无效")
                        .and_then(|bytes| {
                            String::from_utf8(bytes).map_err(|_| "Bing 跳转 URL 不是 UTF-8")
                        })
                })
                .transpose()?
        }
        _ => None,
    };
    let url = target
        .map(|value| Url::parse(&value))
        .unwrap_or(Ok(url))
        .map_err(|_| "搜索目标 URL 无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("搜索目标必须是无认证信息的 HTTP(S) URL".into());
    }
    Ok(url.to_string())
}

/// 根据各源的原始排名融合结果；稳定排序不受网络完成先后影响。
///
/// 同页不同锚点合并，保留首个完整来源 URL；返回最多 `maximum` 项。
///
/// # 错误
/// 输入结果含无效 URL 时返回错误，不静默丢弃该来源。
pub fn merge_results(
    batches: Vec<Vec<SearchResult>>,
    maximum: usize,
) -> Result<Vec<SearchResult>, String> {
    let mut entries: BTreeMap<String, (SearchResult, f64)> = BTreeMap::new();
    for batch in batches {
        let mut seen = std::collections::BTreeSet::new();
        for (rank, result) in batch.into_iter().enumerate() {
            let mut key = Url::parse(&result.url).map_err(|_| "融合搜索结果时发现无效 URL")?;
            key.set_fragment(None);
            if !seen.insert(key.to_string()) {
                continue;
            }
            let score = 1.0 / (60.0 + rank as f64 + 1.0);
            let entry = entries
                .entry(key.to_string())
                .or_insert((result.clone(), 0.0));
            entry.1 += score;
            if result.summary.len() > entry.0.summary.len() {
                entry.0.summary = result.summary;
            }
        }
    }
    let mut results: Vec<_> = entries.into_iter().collect();
    results.sort_by(|left, right| {
        right
            .1
            .1
            .total_cmp(&left.1.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    Ok(results
        .into_iter()
        .take(maximum)
        .map(|(_, value)| value.0)
        .collect())
}

/// 两个搜索任务各自受 `budget` 约束，返回最多 `maximum` 条融合结果和失败源说明。
/// 单源失败保留另一源的观察；全部失败或融合输入无效时返回明确错误。
pub(super) async fn collect_results(
    bing: impl std::future::Future<Output = Result<SearchBatch, String>>,
    duckduckgo: impl std::future::Future<Output = Result<SearchBatch, String>>,
    budget: std::time::Duration,
    maximum: usize,
) -> Result<super::WebOutput, String> {
    // 每个源独立终止，整次调用仍留有合并和提交结果的预算。
    let (bing, duckduckgo) = tokio::join!(
        source_with_budget(bing, budget),
        source_with_budget(duckduckgo, budget)
    );
    let mut warnings = Vec::new();
    let mut batches = Vec::new();
    for (engine, result) in [
        (SearchEngine::Bing, bing),
        (SearchEngine::Duckduckgo, duckduckgo),
    ] {
        match result {
            Ok(batch) => {
                batches.push(batch.results);
                warnings.extend(batch.warnings.into_iter().map(|reason| SearchWarning {
                    source: engine,
                    reason,
                }));
            }
            Err(reason) => warnings.push(SearchWarning {
                source: engine,
                reason,
            }),
        }
    }
    if batches.is_empty() {
        return Err(format!(
            "search：所有搜索源失败；{}",
            warnings
                .iter()
                .map(|warning| format!("{}：{}", warning.source, warning.reason))
                .collect::<Vec<_>>()
                .join("；")
        ));
    }
    Ok(super::WebOutput::Search {
        results: merge_results(batches, maximum)?,
        warnings,
    })
}

async fn source_with_budget(
    operation: impl std::future::Future<Output = Result<SearchBatch, String>>,
    budget: std::time::Duration,
) -> Result<SearchBatch, String> {
    tokio::time::timeout(budget, operation)
        .await
        .map_err(|_| format!("搜索源超时：超过独立的 {} 毫秒预算", budget.as_millis()))?
}

#[cfg(test)]
#[path = "../../../../../test/agent/web/integration/search.rs"]
mod tests;
