//! 搜索捕获提交时的库归属，在 N-API 后台任务中执行；取消信号不等待查询锁。

use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;
use nous_vault::{SearchCancellation, SearchMatchesPage, SearchPage, SearchQuery, Vault};
use std::sync::Arc;

use crate::runtime::{lock_state, to_napi};

/// 一页已验证命中；续页游标只能用于相同表达式、页长与库版本。
#[napi(object)]
pub struct JsSearchPage {
    /// 当前页文件。
    pub hits: Vec<JsSearchHit>,
    /// 没有更多命中时明确为 null。
    pub next_cursor: Either<String, Null>,
}

/// 同版本文件内的下一批具体命中，最多二十处。
#[napi(object)]
pub struct JsSearchMatchesPage {
    /// 本次新加载的位置与上下文。
    pub matches: Vec<JsSearchMatch>,
    /// 没有更多命中时明确为 null。
    pub next_cursor: Either<String, Null>,
}

/// 单篇命中任务与文件分页共享会话取消信号，并发展开不会互相取消。
pub struct MatchesTask {
    vault: Arc<Vault>,
    query: SearchQuery,
    cursor: String,
    cancellation: SearchCancellation,
}

impl Task for MatchesTask {
    type Output = SearchMatchesPage;
    type JsValue = JsSearchMatchesPage;

    fn compute(&mut self) -> Result<Self::Output> {
        self.vault
            .search_matches(&self.query, &self.cursor, &self.cancellation)
            .map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, page: SearchMatchesPage) -> Result<Self::JsValue> {
        if self.cancellation.is_cancelled() {
            return Err(to_napi(nous_vault::Error::SearchCancelled));
        }
        Ok(JsSearchMatchesPage {
            matches: page.matches.into_iter().map(map_match).collect(),
            next_cursor: page.next_cursor.map_or(Either::B(Null), Either::A),
        })
    }
}

/// 原生异步搜索任务；只持有提交时的库与取消令牌，切库后不能读取新库。
pub struct SearchTask {
    vault: Arc<Vault>,
    query: SearchQuery,
    cursor: Option<String>,
    cancellation: SearchCancellation,
}

impl Task for SearchTask {
    type Output = SearchPage;
    type JsValue = JsSearchPage;

    fn compute(&mut self) -> Result<Self::Output> {
        self.vault
            .search_page(&self.query, self.cursor.as_deref(), &self.cancellation)
            .map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, page: SearchPage) -> Result<Self::JsValue> {
        // compute 完成和 JS 投递之间仍可能被取消，不能发布已经失效的结果。
        if self.cancellation.is_cancelled() {
            return Err(to_napi(nous_vault::Error::SearchCancelled));
        }
        Ok(JsSearchPage {
            hits: page.hits.into_iter().map(map_hit).collect(),
            next_cursor: page.next_cursor.map_or(Either::B(Null), Either::A),
        })
    }
}

/// 提交异步搜索；新 ID 替代旧会话，同 ID 的文件和命中续页共享取消令牌。
/// 未打开库、参数、游标或索引错误会拒绝；取消不返回部分结果。
#[napi(ts_return_type = "Promise<JsSearchPage>")]
pub fn search_query(
    query: JsSearchQuery,
    id: String,
    cursor: Option<String>,
) -> Result<AsyncTask<SearchTask>> {
    if id.is_empty() || id.len() > 128 || cursor.as_ref().is_some_and(|value| value.len() > 8192) {
        return Err(Error::from_reason("搜索请求标识或续页游标无效"));
    }
    let query = SearchQuery {
        expr: search_expr(query.expr, 0)?,
        limit: i64::from(query.limit),
    };
    let (vault, cancellation) = session(id, cursor.is_some())?;
    Ok(AsyncTask::new(SearchTask {
        vault,
        query,
        cursor,
        cancellation,
    }))
}

/// 加载当前搜索会话中的下一批命中；过期会话、游标或库版本会拒绝，不复活旧搜索。
#[napi(ts_return_type = "Promise<JsSearchMatchesPage>")]
pub fn search_matches(
    query: JsSearchQuery,
    id: String,
    cursor: String,
) -> Result<AsyncTask<MatchesTask>> {
    if id.is_empty() || id.len() > 128 || cursor.is_empty() || cursor.len() > 8192 {
        return Err(Error::from_reason("搜索请求标识或命中续页游标无效"));
    }
    let query = SearchQuery {
        expr: search_expr(query.expr, 0)?,
        limit: i64::from(query.limit),
    };
    let (vault, cancellation) = session(id, true)?;
    Ok(AsyncTask::new(MatchesTask {
        vault,
        query,
        cursor,
        cancellation,
    }))
}

/// 续页只加入现存会话；取消或切库后迟到的展开请求不能取消新查询。
fn session(id: String, continuation: bool) -> Result<(Arc<Vault>, SearchCancellation)> {
    let mut state = lock_state()?;
    let state = state
        .as_mut()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    if let Some((current, cancellation)) = &state.search {
        if current == &id {
            return Ok((Arc::clone(&state.vault), cancellation.clone()));
        }
    }
    if continuation {
        return Err(to_napi(nous_vault::Error::SearchCancelled));
    }
    let cancellation = SearchCancellation::default();
    if let Some((_, previous)) = state.search.replace((id, cancellation.clone())) {
        previous.cancel();
    }
    Ok((Arc::clone(&state.vault), cancellation))
}

/// 只取消匹配 ID 的任务；迟到的旧请求不能取消新查询，已完成或已关闭时可安全重试。
#[napi]
pub fn search_cancel(id: String) -> Result<()> {
    let mut state = lock_state()?;
    if let Some(state) = state.as_mut() {
        if state
            .search
            .as_ref()
            .is_some_and(|(current, _)| current == &id)
        {
            if let Some((_, token)) = state.search.take() {
                token.cancel();
            }
        }
    }
    Ok(())
}

fn map_hit(hit: nous_vault::SearchHit) -> JsSearchHit {
    JsSearchHit {
        path: hit.path,
        title: hit.title,
        snippet: hit.snippet,
        content_hash: hit.content_hash,
        matches: hit.matches.into_iter().map(map_match).collect(),
        match_count: hit.match_count,
        matches_cursor: hit.matches_cursor.map_or(Either::B(Null), Either::A),
    }
}

fn map_match(item: nous_vault::SearchMatch) -> JsSearchMatch {
    JsSearchMatch {
        snippet: item.snippet,
        location: item.location.map_or(Either::B(Null), |location| {
            Either::A(JsSearchLocation {
                start_byte: location.start_byte,
                end_byte: location.end_byte,
                line: location.line,
            })
        }),
    }
}

/// 检索表达式节点；查询文本解析在渲染层完成。
///
/// `kind` 为 `and`/`or`（`children` 为子条件）、`not`/`line`/`section`（恰好一个子条件）、
/// `term`/`regex`/`tag`/`path`/`file`（`value` 为文本）或 `attr`（`key` 必填，`value` 可缺）。
#[napi(object)]
pub struct JsSearchExpr {
    /// 节点种类。
    pub kind: String,
    /// 文本值；属性节点缺失表示只要求键存在。
    pub value: Option<String>,
    /// 属性名；只用于 `attr`。
    pub key: Option<String>,
    /// 子条件。
    pub children: Option<Vec<JsSearchExpr>>,
}

/// 一次检索：表达式与每页文件数。
#[napi(object)]
pub struct JsSearchQuery {
    /// 检索表达式。
    pub expr: JsSearchExpr,
    /// 每页文件数；非正数按内核默认值处理。
    pub limit: i32,
}

/// 表达式嵌套深度上限；主进程已校验，这里是跨语言边界的最后一道防线。
const SEARCH_DEPTH_LIMIT: usize = 32;

fn search_expr(node: JsSearchExpr, depth: usize) -> Result<nous_vault::SearchExpr> {
    use nous_vault::SearchExpr;
    if depth > SEARCH_DEPTH_LIMIT {
        return Err(Error::from_reason("检索条件嵌套过深"));
    }
    let children = |node: JsSearchExpr| -> Result<Vec<SearchExpr>> {
        node.children
            .unwrap_or_default()
            .into_iter()
            .map(|child| search_expr(child, depth + 1))
            .collect()
    };
    let only = |node: JsSearchExpr| -> Result<Box<SearchExpr>> {
        let mut list = children(node)?;
        if list.len() != 1 {
            return Err(Error::from_reason("检索条件的子条件数量无效"));
        }
        Ok(Box::new(list.remove(0)))
    };
    let text =
        |value: Option<String>| value.ok_or_else(|| Error::from_reason("检索条件缺少文本值"));
    Ok(match node.kind.as_str() {
        "and" => SearchExpr::And(children(node)?),
        "or" => SearchExpr::Or(children(node)?),
        "not" => SearchExpr::Not(only(node)?),
        "line" => SearchExpr::Line(only(node)?),
        "section" => SearchExpr::Section(only(node)?),
        "term" => SearchExpr::Term(text(node.value)?),
        "regex" => SearchExpr::Regex(text(node.value)?),
        "tag" => SearchExpr::Tag(text(node.value)?),
        "path" => SearchExpr::Path(text(node.value)?),
        "file" => SearchExpr::File(text(node.value)?),
        "attr" => SearchExpr::Attr {
            key: node
                .key
                .ok_or_else(|| Error::from_reason("属性条件缺少键"))?,
            value: node.value,
        },
        _ => return Err(Error::from_reason("未知的检索条件种类")),
    })
}

/// 一条搜索命中。
#[napi(object)]
pub struct JsSearchHit {
    /// 命中文件库内相对路径。
    pub path: String,
    /// 展示标题。
    pub title: String,
    /// 正文摘要；命中词以 U+0001/U+0002 控制字符包围，可能为空串。
    pub snippet: String,
    /// 与命中范围同版本的文件 SHA-256。
    pub content_hash: String,
    /// 首批最多五处具体命中，按正文顺序排列。
    pub matches: Vec<JsSearchMatch>,
    /// 去重后的精确正文命中总数。
    pub match_count: i64,
    /// 单篇后续命中的游标，没有更多时明确为 null。
    pub matches_cursor: Either<String, Null>,
}

/// 一处命中的源码位置与上下文。
#[napi(object)]
pub struct JsSearchMatch {
    /// 无法证明源码映射时不返回位置，禁止用同名词猜测。
    pub location: Either<JsSearchLocation, Null>,
    /// 本处命中的高亮上下文。
    pub snippet: String,
}

/// UTF-8 源码区间；范围仅对结果携带的内容版本有效。
#[napi(object)]
pub struct JsSearchLocation {
    /// 起点（含）。
    pub start_byte: i64,
    /// 终点（不含）。
    pub end_byte: i64,
    /// 一基行号。
    pub line: i64,
}
