//! 搜索捕获提交时的库归属，在 N-API 后台任务中执行；取消信号不等待查询锁。

use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;
use nous_core::{SearchCancellation, SearchMatchesPage, SearchPage, SearchQuery, Vault};
use std::sync::Arc;

use super::{
    lock_state, search_expr, to_napi, JsSearchHit, JsSearchLocation, JsSearchMatch, JsSearchQuery,
};

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
            return Err(to_napi(nous_core::Error::SearchCancelled));
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
            return Err(to_napi(nous_core::Error::SearchCancelled));
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
        return Err(to_napi(nous_core::Error::SearchCancelled));
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

/// 切库开始即终止旧查询；打开失败时原库仍可接受后续新查询。
pub(super) fn cancel_current() -> Result<()> {
    if let Some(state) = lock_state()?.as_mut() {
        if let Some((_, token)) = state.search.take() {
            token.cancel();
        }
    }
    Ok(())
}

fn map_hit(hit: nous_core::SearchHit) -> JsSearchHit {
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

fn map_match(item: nous_core::SearchMatch) -> JsSearchMatch {
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
