//! Node-API 绑定：只转发 `nous-core`，不在此层写业务。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use nous_core::{LinkKind, Vault, WatchHandle, WriteOutcome};

pub mod entry_batch;
pub mod search;

struct AppState {
    vault: Arc<Vault>,
    _watch: WatchHandle,
    search: Option<(String, nous_core::SearchCancellation)>,
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Some((_, token)) = &self.search {
            token.cancel();
        }
    }
}

static STATE: Mutex<Option<AppState>> = Mutex::new(None);

/// 监视通知携带受影响路径及健康状态；失败不能伪装成一次成功刷新。
#[napi(object)]
pub struct JsVaultEvent {
    /// changed、watch-error 或 index-error。
    pub status: String,
    /// 已约束到当前库的相对路径，空列表表示需要完整刷新。
    pub paths: Vec<String>,
    /// 本次确实完成了监视后的索引校验。
    pub healthy: bool,
    /// 异常原因；成功事件不提供。
    pub message: Option<String>,
}

fn to_napi(err: nous_core::Error) -> Error {
    Error::from_reason(err.to_string())
}

fn lock_state() -> Result<std::sync::MutexGuard<'static, Option<AppState>>> {
    entry_batch::check_callback_reentry()?;
    STATE
        .lock()
        .map_err(|_| Error::from_reason("内核状态锁已毒化"))
}

/// 在整个内核调用期间持有状态锁，切库不能使正在执行的操作失去归属。
fn with_vault<T>(
    operation: impl FnOnce(&Vault) -> std::result::Result<T, nous_core::Error>,
) -> Result<T> {
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    operation(&state.vault).map_err(to_napi)
}

/// 打开库并开始监视。
///
/// `root` 是库目录，`index_dir` 是库外的派生索引与恢复目录。
/// 监视线程在防抖与索引刷新后，将 `on_changed` 投递给持有内核的 JS 线程。
/// 成功后替换当前库及其监视器；失败时保留原库。
///
/// # Errors
///
/// 打不开目录、索引或监视器时失败。
#[napi]
pub fn vault_open(root: String, index_dir: String, on_changed: JsFunction) -> Result<()> {
    search::cancel_current()?;
    let tsfn: ThreadsafeFunction<JsVaultEvent, ErrorStrategy::Fatal> =
        on_changed.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;
    let vault = Arc::new(Vault::open(&root, &index_dir).map_err(to_napi)?);
    // macOS 监视事件会使用 /private/var 等物理路径，比较前只规范化库根，删除事件不能再解析文件。
    let watch_root = std::fs::canonicalize(vault.root())
        .map_err(|error| Error::from_reason(error.to_string()))?;
    let watched = Arc::clone(&vault);
    let watch = nous_core::start_watch(root, Duration::from_millis(300), move |event| {
        let notification = match event {
            Err(message) => JsVaultEvent {
                status: "watch-error".into(),
                paths: Vec::new(),
                healthy: false,
                message: Some(message),
            },
            Ok(paths) => {
                let paths = paths
                    .into_iter()
                    .filter_map(|path| {
                        path.strip_prefix(&watch_root)
                            .ok()
                            .map(nous_core::path_to_slashes)
                    })
                    .collect::<std::result::Result<Vec<_>, _>>();
                let (paths, refreshed) = match paths {
                    Ok(paths) => (paths, watched.refresh_index()),
                    Err(error) => (Vec::new(), Err(error)),
                };
                match refreshed {
                    Ok(_) => JsVaultEvent {
                        status: "changed".into(),
                        paths,
                        healthy: true,
                        message: None,
                    },
                    Err(error) => JsVaultEvent {
                        status: "index-error".into(),
                        paths,
                        healthy: false,
                        message: Some(error.to_string()),
                    },
                }
            }
        };
        tsfn.call(notification, ThreadsafeFunctionCallMode::NonBlocking);
    })
    .map_err(to_napi)?;
    let mut state = lock_state()?;
    *state = Some(AppState {
        vault,
        _watch: watch,
        search: None,
    });
    Ok(())
}

/// 关闭当前库并停止监视。
///
/// # Errors
///
/// 锁毒化时失败。
#[napi]
pub fn vault_close() -> Result<()> {
    let mut state = lock_state()?;
    *state = None;
    Ok(())
}

/// 列出库内相对路径。
///
/// # Errors
///
/// 未打开库或读目录失败。
#[napi]
pub fn vault_list() -> Result<Vec<String>> {
    with_vault(Vault::list_files)
}

/// 文件树条目，包含空文件夹。
#[napi(object)]
pub struct JsVaultEntry {
    /// 库内相对路径。
    pub path: String,
    /// file 或 directory。
    pub kind: String,
    /// 仅在草稿无法对应真实文件条目时设置。
    pub recovery_only: Option<bool>,
}

/// 列出完整目录；未打开库或目录读取失败时返回错误。
#[napi]
pub fn vault_entries() -> Result<Vec<JsVaultEntry>> {
    Ok(with_vault(Vault::list_entries)?
        .into_iter()
        .map(|entry| JsVaultEntry {
            path: entry.path,
            kind: match entry.kind {
                nous_core::EntryKind::File => "file",
                nous_core::EntryKind::Directory => "directory",
            }
            .into(),
            recovery_only: entry.recovery_only.then_some(true),
        })
        .collect())
}

/// 创建笔记或文件夹；`content` 是文件初始字节（缺省为空），创建与写入
/// 是同一次独占提交。非法类型、同名目标、目录携带内容或磁盘失败时拒绝。
#[napi]
pub fn entry_create(
    path: String,
    kind: String,
    content: Option<Buffer>,
) -> Result<JsRenameOutcome> {
    let kind = match kind.as_str() {
        "file" => nous_core::EntryKind::File,
        "directory" => nous_core::EntryKind::Directory,
        _ => return Err(Error::from_reason("未知条目类型")),
    };
    let content = content.map(|buffer| buffer.to_vec());
    Ok(JsRenameOutcome {
        warning: with_vault(|vault| {
            vault.create_entry(&path, kind, content.as_deref().unwrap_or(&[]))
        })?
        .warning,
    })
}

/// 独占导入的附件位置和提交后警告。
#[napi(object)]
pub struct JsImportedAttachment {
    /// 实际库内路径，同名避让后可能与原文件名不同。
    pub path: String,
    /// 文件已落盘后发生的索引或同步错误。
    pub warning: Option<String>,
}

/// 导入用户选择的附件字节，返回实际位置；路径、大小与写盘错误由内核传播。
#[napi]
pub fn attachment_import(
    from: String,
    name: String,
    bytes: Buffer,
) -> Result<JsImportedAttachment> {
    let result = with_vault(|vault| vault.import_attachment(&from, &name, bytes.as_ref()))?;
    Ok(JsImportedAttachment {
        path: result.path,
        warning: result.warning,
    })
}

/// 移入系统废纸篓；失败不退化为永久删除，未保存草稿阻止操作。
#[napi]
pub fn entry_trash(path: String) -> Result<JsRenameOutcome> {
    let result = with_vault(|vault| {
        vault.trash_entry(&path, |absolute| {
            trash::delete(absolute)
                .map_err(|error| nous_core::Error::Io(std::io::Error::other(error.to_string())))
        })
    })?;
    Ok(JsRenameOutcome {
        warning: result.warning,
    })
}

/// 批量预检的独立条目，不包含未经确认的覆盖或永久删除选项。
#[napi(object)]
pub struct JsEntryMutation {
    /// 规范的库内源路径。
    pub from: String,
    /// 缺席表示废纸篓操作，否则为规范移动目标。
    pub to: Option<String>,
}

/// 预检整批操作；不修改用户文件，路径、草稿或目标冲突通过异常返回。
#[napi]
pub fn entry_check_batch(changes: Vec<JsEntryMutation>) -> Result<()> {
    let changes: Vec<_> = changes
        .into_iter()
        .map(|change| nous_core::EntryMutation {
            from: change.from,
            to: change.to,
        })
        .collect();
    with_vault(|vault| vault.check_entry_batch(&changes))
}

/// 获取经过库根校验的现有路径，只供主进程调用系统文件管理器。
#[napi]
pub fn entry_path(path: String) -> Result<String> {
    Ok(with_vault(|vault| vault.entry_path(&path))?
        .to_string_lossy()
        .into_owned())
}

/// 读取文件原始字节。
///
/// # Errors
///
/// 未打开库、越界或不存在。
#[napi]
pub fn file_read(rel: String) -> Result<Buffer> {
    with_vault(|vault| vault.read(&rel)).map(Buffer::from)
}

/// 已持久化的恢复草稿。
#[napi(object)]
pub struct JsDraft {
    /// 普通草稿为最新内容；存在 editor 时为重建源码映射的原始字节。
    pub bytes: Buffer,
    /// 原编辑基准；缺失表示新文件。
    pub base: Option<Buffer>,
    /// 版本化的编辑器恢复内容；没有时按普通 Markdown 字节恢复。
    pub editor: Option<String>,
}

/// 编辑器加载快照，文件删除时仍可恢复草稿。
#[napi(object)]
pub struct JsFileSnapshot {
    /// 磁盘内容；缺失时通过 disk_error 区分删除与读取失败。
    pub disk: Option<Buffer>,
    /// 原路径不可读时保留草稿，并携带原因。
    pub disk_error: Option<String>,
    /// 尚未提交的编辑。
    pub draft: Option<JsDraft>,
}

/// 获取 `rel` 的磁盘内容与恢复草稿。
///
/// # Errors
///
/// 未打开库、越界或读取失败。
#[napi]
pub fn file_snapshot(rel: String) -> Result<JsFileSnapshot> {
    let snapshot = with_vault(|vault| vault.snapshot(&rel))?;
    Ok(JsFileSnapshot {
        disk: snapshot.disk.map(Buffer::from),
        disk_error: snapshot.disk_error,
        draft: snapshot.draft.map(|draft| JsDraft {
            bytes: Buffer::from(draft.bytes),
            base: draft.base.map(Buffer::from),
            editor: draft.editor,
        }),
    })
}

/// 持久化带版本的编辑恢复数据，保持原笔记字节不变。
///
/// # Errors
/// 未打开库、路径或数据非法、恢复记录冲突或数据库不可写。
#[napi]
pub fn file_preserve_draft(
    rel: String,
    source: Buffer,
    expected: Option<Buffer>,
    editor: String,
) -> Result<()> {
    with_vault(|vault| {
        vault.preserve_editor_draft(&rel, source.as_ref(), expected.as_deref(), &editor)
    })
}

/// 文件提交结果，冲突时附带磁盘版本。
#[napi(object)]
pub struct JsWriteResult {
    /// `saved` 或 `conflict`。
    pub status: String,
    /// 冲突的磁盘字节；缺失也可能表示文件被删除。
    pub disk: Option<Buffer>,
    /// 已提交后的同步、索引或清理警告。
    pub warning: Option<String>,
}

/// 按 `expected` 基准保存 `bytes`，返回提交状态或冲突。
///
/// # Errors
///
/// 未打开库、越界、草稿持久化或内容提交失败。
#[napi]
pub fn file_write(rel: String, bytes: Buffer, expected: Option<Buffer>) -> Result<JsWriteResult> {
    let result = with_vault(|vault| vault.write(&rel, bytes.as_ref(), expected.as_deref()))?;
    Ok(match result {
        WriteOutcome::Saved { warning } => JsWriteResult {
            status: "saved".into(),
            disk: None,
            warning,
        },
        WriteOutcome::Conflict { disk } => JsWriteResult {
            status: "conflict".into(),
            disk: disk.map(Buffer::from),
            warning: None,
        },
    })
}

/// 新副本的路径与提交后警告。
#[napi(object)]
pub struct JsSavedCopy {
    /// 实际创建的相对路径。
    pub path: String,
    /// 内容已保存后的警告。
    pub warning: Option<String>,
}

/// 将当前 `bytes` 写入唯一命名的新副本，`expected` 用于恢复基准。
///
/// # Errors
///
/// 未打开库、路径非法或副本提交失败。
#[napi]
pub fn file_write_copy(
    rel: String,
    bytes: Buffer,
    expected: Option<Buffer>,
) -> Result<JsSavedCopy> {
    let copy = with_vault(|vault| vault.write_copy(&rel, bytes.as_ref(), expected.as_deref()))?;
    Ok(JsSavedCopy {
        path: copy.path,
        warning: copy.warning,
    })
}

/// 链接解析结果：路径、锚点与歧义候选分开返回。
#[napi(object)]
pub struct JsLinkTarget {
    /// `resolved`、`ambiguous` 或 `dead`。
    pub status: String,
    /// 唯一命中的库内路径；仅 `resolved` 提供。
    pub path: Option<String>,
    /// 歧义候选路径（升序）；仅 `ambiguous` 提供。
    pub candidates: Option<Vec<String>>,
    /// 已解码的标题锚点；无锚点为缺失。
    pub anchor: Option<String>,
}

/// 解析链接目标。
///
/// `kind` 为 `wiki` 或 `md`。歧义时返回全部候选，由界面让用户选择。
///
/// # Errors
///
/// 未打开库或 kind 非法。
#[napi]
pub fn links_resolve(from: String, raw: String, kind: String) -> Result<JsLinkTarget> {
    let kind: LinkKind = kind
        .parse()
        .map_err(|()| Error::from_reason("未知链接种类"))?;
    with_vault(|vault| {
        Ok(match vault.resolve_link(&from, &raw, kind) {
            nous_core::LinkTarget::Resolved { path, anchor } => JsLinkTarget {
                status: "resolved".into(),
                path: Some(path),
                candidates: None,
                anchor,
            },
            nous_core::LinkTarget::Ambiguous { candidates, anchor } => JsLinkTarget {
                status: "ambiguous".into(),
                path: None,
                candidates: Some(candidates),
                anchor,
            },
            nous_core::LinkTarget::Dead => JsLinkTarget {
                status: "dead".into(),
                path: None,
                candidates: None,
                anchor: None,
            },
        })
    })
}

/// 一条索引中的链接。
#[napi(object)]
pub struct JsLinkRecord {
    /// 源文件相对路径。
    pub from_path: String,
    /// 链接原文中的目标。
    pub to_raw: String,
    /// 解析到的路径；死链、歧义和纯锚点为 `null`。
    pub to_path: Option<String>,
    /// `wiki` 或 `md`。
    pub kind: String,
    /// 字节区间起点（含）。
    pub start_byte: i64,
    /// 字节区间终点（不含）。
    pub end_byte: i64,
    /// `resolved`、`ambiguous`、`dead` 或 `self`。
    pub resolution: String,
}

fn to_js(link: nous_core::LinkRecord) -> JsLinkRecord {
    JsLinkRecord {
        from_path: link.from_path,
        to_raw: link.to_raw,
        to_path: link.to_path,
        kind: link.kind.as_str().to_string(),
        start_byte: link.start_byte,
        end_byte: link.end_byte,
        resolution: link.resolution.as_str().to_string(),
    }
}

/// 一条已链接或未链接提及。
#[napi(object)]
pub struct JsMentionRecord {
    /// 源文件相对路径。
    pub from_path: String,
    /// 源文件展示标题。
    pub from_title: String,
    /// 源文件内容修改时间（自纪元起的纳秒）。
    pub mtime: i64,
    /// 命中区间起点（含）。
    pub start_byte: i64,
    /// 命中区间终点（不含）。
    pub end_byte: i64,
    /// 命中所在段落。
    pub snippet: String,
    /// `linked` 或 `unlinked`。
    pub kind: String,
    /// 已链接时为 `wiki`/`md`；未链接为 `null`。
    pub link_kind: Option<String>,
    /// 已链接为链接原文目标；未链接为命中文本。
    pub to_raw: String,
}

/// 指向一篇笔记的已链接与未链接提及。
#[napi(object)]
pub struct JsMentions {
    /// 索引里的入链。
    pub linked: Vec<JsMentionRecord>,
    /// 正文里尚未做成链接的出现。
    pub unlinked: Vec<JsMentionRecord>,
}

fn to_js_mention(mention: nous_core::MentionRecord) -> JsMentionRecord {
    JsMentionRecord {
        from_path: mention.from_path,
        from_title: mention.from_title,
        mtime: mention.mtime,
        start_byte: mention.start_byte,
        end_byte: mention.end_byte,
        snippet: mention.snippet,
        kind: mention.kind.as_str().to_string(),
        link_kind: mention.link_kind.map(|kind| kind.as_str().to_string()),
        to_raw: mention.to_raw,
    }
}

/// 指向 `path` 的入链。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_links_to(path: String) -> Result<Vec<JsLinkRecord>> {
    Ok(with_vault(|vault| vault.links_to(&path))?
        .into_iter()
        .map(to_js)
        .collect())
}

/// `path` 的出链。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_links_from(path: String) -> Result<Vec<JsLinkRecord>> {
    Ok(with_vault(|vault| vault.links_from(&path))?
        .into_iter()
        .map(to_js)
        .collect())
}

/// 指向 `path` 的已链接提及与未链接提及。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_mentions_to(path: String) -> Result<JsMentions> {
    let mentions = with_vault(|vault| vault.mentions_to(&path))?;
    Ok(JsMentions {
        linked: mentions.linked.into_iter().map(to_js_mention).collect(),
        unlinked: mentions.unlinked.into_iter().map(to_js_mention).collect(),
    })
}

/// 把 `from` 文件里 `[start_byte, end_byte)` 的未链接提及就地转为指向
/// `target` 的 wiki 链接；`expected` 是查询时的提及文本，文件已变化时拒绝。
///
/// # Errors
///
/// 未打开库、目标不在库内、区间过期或写盘失败。
#[napi]
pub fn mentions_linkify(
    from: String,
    start_byte: i64,
    end_byte: i64,
    expected: String,
    target: String,
) -> Result<JsRenameOutcome> {
    let result =
        with_vault(|vault| vault.linkify_mention(&from, start_byte, end_byte, &expected, &target))?;
    Ok(JsRenameOutcome {
        warning: result.warning,
    })
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

fn search_expr(node: JsSearchExpr, depth: usize) -> Result<nous_core::SearchExpr> {
    use nous_core::SearchExpr;
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

/// 索引里的一条标题记录。
#[napi(object)]
pub struct JsHeadingRecord {
    /// 源文件相对路径。
    pub path: String,
    /// 标题等级（1–6）。
    pub level: i64,
    /// 去除行内语法后的标题纯文本。
    pub text: String,
    /// 字节区间起点（含）。
    pub start_byte: i64,
    /// 字节区间终点（不含）。
    pub end_byte: i64,
}

/// 全库标签计数的一行。
#[napi(object)]
pub struct JsTagCount {
    /// 规范化标签（小写、无 `#`）。
    pub tag: String,
    /// 携带该标签的文件数。
    pub count: i64,
}

/// 全库标签及计数，标签升序；供标签浏览面板。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_tags() -> Result<Vec<JsTagCount>> {
    let counts = with_vault(Vault::tag_counts)?;
    Ok(counts
        .into_iter()
        .map(|count| JsTagCount {
            tag: count.tag,
            count: count.count,
        })
        .collect())
}

/// 一条书签；`kind` 为 `file`/`folder`（`path`）、`heading`（`path` 与 `heading`）或 `search`（`query`）。
#[napi(object)]
pub struct JsBookmark {
    /// 书签种类。
    pub kind: String,
    /// 库内相对路径；文件、文件夹与标题书签必填。
    pub path: Option<String>,
    /// 标题原文；只用于标题书签。
    pub heading: Option<String>,
    /// 查询文本；只用于搜索书签。
    pub query: Option<String>,
    /// 自定义显示名。
    pub title: Option<String>,
}

fn js_bookmark(bookmark: nous_core::Bookmark) -> JsBookmark {
    use nous_core::Bookmark;
    let (kind, path, heading, query, title) = match bookmark {
        Bookmark::File { path, title } => ("file", Some(path), None, None, title),
        Bookmark::Folder { path, title } => ("folder", Some(path), None, None, title),
        Bookmark::Heading {
            path,
            heading,
            title,
        } => ("heading", Some(path), Some(heading), None, title),
        Bookmark::Search { query, title } => ("search", None, None, Some(query), title),
    };
    JsBookmark {
        kind: kind.to_string(),
        path,
        heading,
        query,
        title,
    }
}

fn core_bookmark(bookmark: JsBookmark) -> Result<nous_core::Bookmark> {
    use nous_core::Bookmark;
    let missing = |field: &str| Error::from_reason(format!("书签缺少字段 {field}"));
    Ok(match bookmark.kind.as_str() {
        "file" => Bookmark::File {
            path: bookmark.path.ok_or_else(|| missing("path"))?,
            title: bookmark.title,
        },
        "folder" => Bookmark::Folder {
            path: bookmark.path.ok_or_else(|| missing("path"))?,
            title: bookmark.title,
        },
        "heading" => Bookmark::Heading {
            path: bookmark.path.ok_or_else(|| missing("path"))?,
            heading: bookmark.heading.ok_or_else(|| missing("heading"))?,
            title: bookmark.title,
        },
        "search" => Bookmark::Search {
            query: bookmark.query.ok_or_else(|| missing("query"))?,
            title: bookmark.title,
        },
        _ => return Err(Error::from_reason("未知的书签种类")),
    })
}

/// 读出库内书签；文件不存在时为空。
///
/// # Errors
///
/// 未打开库、读盘失败或书签文件损坏。
#[napi]
pub fn bookmarks_list() -> Result<Vec<JsBookmark>> {
    let items = with_vault(Vault::bookmarks)?;
    Ok(items.into_iter().map(js_bookmark).collect())
}

/// 整体替换书签清单；损坏的旧文件先备份再覆盖。
///
/// # Errors
///
/// 未打开库、书签字段无效或写盘失败。
#[napi]
pub fn bookmarks_set(items: Vec<JsBookmark>) -> Result<()> {
    let items = items
        .into_iter()
        .map(core_bookmark)
        .collect::<Result<Vec<_>>>()?;
    with_vault(|vault| vault.set_bookmarks(&items))
}

/// 一篇笔记可被点名的标题与别名。
#[napi(object)]
pub struct JsNoteKeys {
    /// 库内相对路径。
    pub path: String,
    /// 展示标题：文首一级标题，缺失时为文件名词干。
    pub title: String,
    /// frontmatter 别名，按书写顺序。
    pub aliases: Vec<String>,
}

/// 全部 Markdown 笔记的标题与别名，路径升序；供快速切换器与别名补全。
///
/// # Errors
///
/// 未打开库或索引查询失败。
#[napi]
pub fn index_note_keys() -> Result<Vec<JsNoteKeys>> {
    let keys = with_vault(Vault::note_keys)?;
    Ok(keys
        .into_iter()
        .map(|note| JsNoteKeys {
            path: note.path,
            title: note.title,
            aliases: note.aliases,
        })
        .collect())
}

/// 图谱节点：笔记或死链目标。
#[napi(object)]
pub struct JsGraphNode {
    /// 笔记的库内相对路径；死链为去掉锚点后的目标原文。
    pub path: String,
    /// 展示标题。
    pub title: String,
    /// 标签，升序。
    pub tags: Vec<String>,
    /// 是否为尚未创建的死链目标。
    pub dead: bool,
}

/// 图谱中的有向边。
#[napi(object)]
pub struct JsGraphEdge {
    /// 源笔记路径。
    pub from: String,
    /// 目标节点的 `path`。
    pub to: String,
    /// 这对起止之间的链接条数。
    pub count: u32,
}

/// 全库图谱。
#[napi(object)]
pub struct JsGraph {
    /// 节点，按路径升序。
    pub nodes: Vec<JsGraphNode>,
    /// 边，按起止升序。
    pub edges: Vec<JsGraphEdge>,
}

/// 全库关系图谱；`include_dead` 为真时死链目标作为虚节点出现。
///
/// # Errors
///
/// 未打开库或索引查询失败。
#[napi]
pub fn index_graph(include_dead: bool) -> Result<JsGraph> {
    let graph = with_vault(|vault| vault.graph(include_dead))?;
    Ok(JsGraph {
        nodes: graph
            .nodes
            .into_iter()
            .map(|node| JsGraphNode {
                path: node.path,
                title: node.title,
                tags: node.tags,
                dead: node.dead,
            })
            .collect(),
        edges: graph
            .edges
            .into_iter()
            .map(|edge| JsGraphEdge {
                from: edge.from,
                to: edge.to,
                count: edge.count,
            })
            .collect(),
    })
}

/// `path` 的全部标题，按文档顺序；供锚点解析与标题补全。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_headings(path: String) -> Result<Vec<JsHeadingRecord>> {
    let headings = with_vault(|vault| vault.headings(&path))?;
    Ok(headings
        .into_iter()
        .map(|heading| JsHeadingRecord {
            path: heading.path,
            level: heading.level,
            text: heading.text,
            start_byte: heading.start_byte,
            end_byte: heading.end_byte,
        })
        .collect())
}

/// 文件已经完成改名，索引或日志清理可能仍需重试。
#[napi(object)]
pub struct JsRenameOutcome {
    /// 提交后的警告；无警告时缺失。
    pub warning: Option<String>,
}

/// 将 `from` 改名为 `to` 并更新全库链接，返回提交后的警告。
///
/// # Errors
///
/// 未打开库、目标已存在或写盘失败。
#[napi]
pub fn entry_rename(from: String, to: String) -> Result<JsRenameOutcome> {
    let result = with_vault(|vault| vault.rename(&from, &to))?;
    Ok(JsRenameOutcome {
        warning: result.warning,
    })
}
