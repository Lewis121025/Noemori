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
    /// 融合结果的语义覆盖；严格查询省略。
    pub semantic: Option<JsSemanticStatus>,
    /// 融合召回是否达到候选预算。
    pub limited: Option<bool>,
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
        let query = parse_query(query)?;
        let cancellation = self.inner.search(id, cursor.is_some()).map_err(to_napi)?;
        let token = cancellation.clone();
        let generation = self.inner.generation();
        let runtime = Arc::clone(&self.inner);
        let pending = runtime.read(move |vault| match query {
            Request::Strict(query) => vault
                .search_page(&query, cursor.as_deref(), &token)
                .map(map_page),
            Request::Hybrid(query) => vault
                .search_hybrid(&query, cursor.as_deref(), &token)
                .map(map_hybrid_page),
        });
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
                Ok(page)
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
        let query = parse_query(query)?;
        let cancellation = self.inner.search(id, true).map_err(to_napi)?;
        let token = cancellation.clone();
        let generation = self.inner.generation();
        let runtime = Arc::clone(&self.inner);
        let pending = runtime.read(move |vault| match query {
            Request::Strict(query) => vault.search_matches(&query, &cursor, &token),
            Request::Hybrid(query) => vault.hybrid_matches(&query, &cursor, &token),
        });
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
        evidence: None,
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
    pub expr: Option<JsSearchExpr>,
    /// hybrid 表示融合查询；省略表示既有严格查询。
    pub kind: Option<String>,
    /// 融合文本。
    pub text: Option<String>,
    /// 融合硬筛选。
    pub filter: Option<JsSearchExpr>,
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
    /// 融合来源证据，不能计入精确正文命中数。
    pub evidence: Option<Vec<JsHybridEvidence>>,
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

/// 语义模型和索引覆盖状态。
#[napi(object)]
pub struct JsSemanticStatus {
    /// missing、indexing、ready 或 error。
    pub state: String,
    /// 已完成的有效笔记数。
    pub indexed: i64,
    /// Markdown 笔记总数。
    pub total: i64,
    /// 具体故障原因。
    pub message: Either<String, Null>,
}

/// 一条相关段落或纠错证据；位置属于结果携带的内容版本。
#[napi(object)]
pub struct JsHybridEvidence {
    /// lexical、fuzzy 或 semantic。
    pub kind: String,
    /// 原文摘要。
    pub snippet: String,
    /// 可证明的源码范围。
    pub location: Either<JsSearchLocation, Null>,
}

enum Request {
    Strict(SearchQuery),
    Hybrid(noemori_vault::HybridQuery),
}
fn parse_query(query: JsSearchQuery) -> Result<Request> {
    if query.kind.as_deref() == Some("hybrid") {
        if query.expr.is_some() {
            return Err(Error::from_reason("融合查询不能同时携带严格表达式"));
        }
        Ok(Request::Hybrid(noemori_vault::HybridQuery {
            text: query
                .text
                .ok_or_else(|| Error::from_reason("融合查询缺少文本"))?,
            filter: search_expr(
                query
                    .filter
                    .ok_or_else(|| Error::from_reason("融合查询缺少筛选"))?,
                0,
            )?,
            limit: i64::from(query.limit),
        }))
    } else if query.kind.is_none() && query.text.is_none() && query.filter.is_none() {
        Ok(Request::Strict(SearchQuery {
            expr: search_expr(
                query
                    .expr
                    .ok_or_else(|| Error::from_reason("严格查询缺少表达式"))?,
                0,
            )?,
            limit: i64::from(query.limit),
        }))
    } else {
        Err(Error::from_reason("未知查询类型"))
    }
}

fn map_status(status: noemori_vault::SemanticStatus) -> JsSemanticStatus {
    use noemori_vault::SemanticState;
    let (state, message) = match status.state {
        SemanticState::Missing => ("missing", None),
        SemanticState::Indexing => ("indexing", None),
        SemanticState::Ready => ("ready", None),
        SemanticState::Failed { message } => ("error", Some(message)),
    };
    JsSemanticStatus {
        state: state.into(),
        indexed: status.indexed,
        total: status.total,
        message: message.map_or(Either::B(Null), Either::A),
    }
}
fn map_page(page: noemori_vault::SearchPage) -> JsSearchPage {
    JsSearchPage {
        hits: page.hits.into_iter().map(map_hit).collect(),
        next_cursor: page.next_cursor.map_or(Either::B(Null), Either::A),
        semantic: None,
        limited: None,
    }
}
fn map_hybrid_page(page: noemori_vault::HybridPage) -> JsSearchPage {
    JsSearchPage {
        hits: page
            .hits
            .into_iter()
            .map(|item| {
                let mut hit = map_hit(item.hit);
                hit.evidence = Some(
                    item.evidence
                        .into_iter()
                        .map(|e| {
                            let mapped = map_match(noemori_vault::SearchMatch {
                                snippet: e.snippet,
                                location: e.location,
                            });
                            JsHybridEvidence {
                                kind: match e.kind {
                                    noemori_vault::EvidenceKind::Lexical => "lexical",
                                    noemori_vault::EvidenceKind::Fuzzy => "fuzzy",
                                    noemori_vault::EvidenceKind::Semantic => "semantic",
                                }
                                .into(),
                                snippet: mapped.snippet,
                                location: mapped.location,
                            }
                        })
                        .collect(),
                );
                hit
            })
            .collect(),
        next_cursor: page.next_cursor.map_or(Either::B(Null), Either::A),
        semantic: Some(map_status(page.semantic)),
        limited: Some(page.limited),
    }
}

#[napi]
impl NativeRuntime {
    /// 在选择本地目录前登记安装会话；明确取消或切库后不能重新启动旧安装。
    #[napi]
    pub fn search_model_begin(&self, id: String) -> Result<()> {
        if id.is_empty() || id.len() > 128 {
            return Err(Error::from_reason("模型安装请求标识无效"));
        }
        self.inner.model_session(id, false).map_err(to_napi)?;
        Ok(())
    }

    /// 取消指定模型安装；普通搜索会话保持有效。
    #[napi]
    pub fn search_model_cancel(&self, id: String) {
        self.inner.cancel_model(&id);
    }

    /// 下载或导入固定 Harrier 模型并调度当前库索引；只等待模型安装，不阻塞保存。
    #[napi(ts_return_type = "Promise<JsSemanticStatus>")]
    pub fn search_model_install(
        &self,
        env: Env,
        source: Option<String>,
        id: String,
    ) -> Result<Object> {
        if id.is_empty() || id.len() > 128 {
            return Err(Error::from_reason("模型安装请求标识无效"));
        }
        let cancellation = self.inner.model_session(id, true).map_err(to_napi)?;
        let pending = self
            .inner
            .install_search_model(source.map(std::path::PathBuf::from), cancellation.clone());
        env.execute_tokio_future(
            async move { pending.await.map_err(to_napi) },
            move |_, status| {
                if cancellation.is_cancelled() {
                    return Err(to_napi(noemori_vault::Error::SearchCancelled));
                }
                Ok(map_status(status))
            },
        )
    }
}
