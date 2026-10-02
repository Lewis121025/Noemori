//! 搜索捕获提交时的库归属，在 N-API 后台任务中执行；取消信号不等待查询锁。

use napi::bindgen_prelude::*;
use napi_derive::napi;
use noemori_vault::SearchQuery;
use std::sync::Arc;

use crate::runtime::{to_napi, NativeRuntime};

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

#[napi]
impl NativeRuntime {
    /// 提交搜索；在调用线程登记会话，旧续页不能替换新搜索。
    #[napi(ts_return_type = "Promise<JsSearchPage>")]
    pub fn search_query(
        &self,
        env: Env,
        query: JsSearchQuery,
        id: String,
        cursor: Option<String>,
    ) -> Result<Object> {
        if id.is_empty() || id.len() > 128 || cursor.as_ref().is_some_and(|c| c.len() > 8192) {
            return Err(Error::from_reason("搜索请求标识或续页游标无效"));
        }
        let query = SearchQuery {
            expr: search_expr(query.expr, 0)?,
            limit: i64::from(query.limit),
        };
        let cancellation = self.inner.search(id, cursor.is_some()).map_err(to_napi)?;
        let token = cancellation.clone();
        let generation = self.inner.generation();
        let runtime = Arc::clone(&self.inner);
        let pending =
            runtime.read(move |vault| vault.search_page(&query, cursor.as_deref(), &token));
        let waiting = cancellation.clone();
        env.execute_tokio_future(
            async move {
                let result = pending.wait().await;
                if waiting.is_cancelled() {
                    return Err(to_napi(noemori_vault::Error::SearchCancelled));
                }
                result.map_err(to_napi)?.map_err(to_napi)
            },
            move |_, page| {
                if cancellation.is_cancelled() || runtime.generation() != generation {
                    return Err(to_napi(noemori_vault::Error::SearchCancelled));
                }
                Ok(JsSearchPage {
                    hits: page.hits.into_iter().map(map_hit).collect(),
                    next_cursor: page.next_cursor.map_or(Either::B(Null), Either::A),
                })
            },
        )
    }

    /// 同会话的命中续页共享取消令牌，交付前再次验证归属。
    #[napi(ts_return_type = "Promise<JsSearchMatchesPage>")]
    pub fn search_matches(
        &self,
        env: Env,
        query: JsSearchQuery,
        id: String,
        cursor: String,
    ) -> Result<Object> {
        if id.is_empty() || id.len() > 128 || cursor.is_empty() || cursor.len() > 8192 {
            return Err(Error::from_reason("搜索请求标识或命中续页游标无效"));
        }
        let query = SearchQuery {
            expr: search_expr(query.expr, 0)?,
            limit: i64::from(query.limit),
        };
        let cancellation = self.inner.search(id, true).map_err(to_napi)?;
        let token = cancellation.clone();
        let generation = self.inner.generation();
        let runtime = Arc::clone(&self.inner);
        let pending = runtime.read(move |vault| vault.search_matches(&query, &cursor, &token));
        let waiting = cancellation.clone();
        env.execute_tokio_future(
            async move {
                let result = pending.wait().await;
                if waiting.is_cancelled() {
                    return Err(to_napi(noemori_vault::Error::SearchCancelled));
                }
                result.map_err(to_napi)?.map_err(to_napi)
            },
            move |_, page| {
                if cancellation.is_cancelled() || runtime.generation() != generation {
                    return Err(to_napi(noemori_vault::Error::SearchCancelled));
                }
                Ok(JsSearchMatchesPage {
                    matches: page.matches.into_iter().map(map_match).collect(),
                    next_cursor: page.next_cursor.map_or(Either::B(Null), Either::A),
                })
            },
        )
    }

    /// 取消仅匹配 ID 的会话，不经过磁盘队列。
    #[napi]
    pub fn search_cancel(&self, id: String) {
        self.inner.cancel_search(&id);
    }
}

fn map_hit(hit: noemori_vault::SearchHit) -> JsSearchHit {
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

fn map_match(item: noemori_vault::SearchMatch) -> JsSearchMatch {
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

fn search_expr(node: JsSearchExpr, depth: usize) -> Result<noemori_vault::SearchExpr> {
    use noemori_vault::SearchExpr;
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
