/**
 * 渲染进程可调用的内核 API。
 *
 * 与 preload `contextBridge` 暴露的对象保持同一类型；禁止在此加入任意文件系统能力。
 */

import type { ImportedAttachment } from "./attachments";
import type { VaultOpenProgress } from "./vault-opening";
import type { SessionDocuments, ViewModes } from "./session";
import type { FileTreeState } from "./file-browser";
import type { EntryBatchProgress, EntryBatchRequest, EntryBatchResult } from "./entry-batch";
import type { ExportRequest, ExportProgress, ExportPlan, ExportResult } from "./export";
import type { ShapeRepair } from "./whiteboard/recognition";
import type { WebPageApi } from "./webpage";

/** 历史动作由当前输入表面执行，不建立独立于编辑器的撤销记录。 */
export type HistoryAction = "undo" | "redo";

/** 当前输入表面的历史可用性；只从编辑器或原生控件派生，不存储撤销记录。 */
export type HistoryAvailability = Readonly<{ undo: boolean; redo: boolean }>;

export type { ReaderCommand } from "./commands";

/** 链接语法。 */
export type LinkKind = "wiki" | "md";

/**
 * 链接解析结果：资源路径与 `#` 锚点分开返回。
 *
 * 歧义（同名多候选）必须由界面让用户选择，不允许静默取一；
 * 纯锚点链接（`[[#标题]]`）解析为源文件自身。
 */
export type LinkTarget =
  | { status: "resolved"; path: string; anchor: string | null }
  | { status: "ambiguous"; candidates: string[]; anchor: string | null }
  | { status: "dead" };

/** 后台能力的故障独立于文档保存状态；路径始终是当前库的相对路径。 */
export type VaultEvent =
  | { status: "changed"; paths: string[]; healthy: boolean }
  | { status: "watch-error" | "index-error" | "worker-error"; paths: string[]; message: string };

/** 校验原生层或线程事件；未知状态和缺失原因会抛错，禁止悄悄当作成功。 */
export function parseVaultEvent(value: unknown): VaultEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    !("paths" in value) ||
    !Array.isArray(value.paths) ||
    !value.paths.every((path: unknown) => typeof path === "string")
  )
    throw new Error("库事件缺少有效状态或路径");
  const paths: string[] = value.paths;
  if (value.status === "changed" && "healthy" in value && typeof value.healthy === "boolean")
    return { status: "changed", paths, healthy: value.healthy };
  if (
    (value.status === "watch-error" ||
      value.status === "index-error" ||
      value.status === "worker-error") &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message !== ""
  )
    return { status: value.status, paths, message: value.message };
  throw new Error("库事件状态无效或缺少错误原因");
}

/** 索引解析状态。`toPath` 只在 `resolved` 时有值。 */
export type LinkResolution = "resolved" | "ambiguous" | "dead" | "self";

/** 索引中的一条链接。 */
export type LinkRecord = {
  /** 源文件库内相对路径。 */
  fromPath: string;
  /** 链接原文中的目标。 */
  toRaw: string;
  /** 唯一解析到的路径；歧义、死链和纯锚点为 `null`。 */
  toPath: string | null;
  /** 语法种类。 */
  kind: LinkKind;
  /** 字节区间起点（含）。 */
  startByte: number;
  /** 字节区间终点（不含）。 */
  endByte: number;
  /** 死链、同名歧义与纯锚点在索引里分开记录。 */
  resolution: LinkResolution;
};

/** 提及是入链还是未做成链接的正文出现。 */
type MentionKind = "linked" | "unlinked";

/** 一条已链接或未链接提及。 */
export type MentionRecord = {
  /** 源文件库内相对路径。 */
  fromPath: string;
  /** 源文件展示标题。 */
  fromTitle: string;
  /** 源文件内容修改时间（自纪元起的纳秒）。 */
  mtime: number;
  /** 命中区间起点（含）。 */
  startByte: number;
  /** 命中区间终点（不含）。 */
  endByte: number;
  /** 命中所在段落。 */
  snippet: string;
  /** 已链接或未链接。 */
  kind: MentionKind;
  /** 已链接时的语法；未链接为 `null`。 */
  linkKind: LinkKind | null;
  /** 已链接为链接原文目标；未链接为命中文本。 */
  toRaw: string;
};

/** 指向一篇笔记的已链接与未链接提及。 */
export type Mentions = {
  /** 索引里的入链。 */
  linked: MentionRecord[];
  /** 正文里尚未做成链接的出现。 */
  unlinked: MentionRecord[];
};

/**
 * 检索表达式；由查询文本在渲染层解析而来。
 *
 * - `and`/`or`：子条件全部/任一满足；空 `and` 表示没有条件。
 * - `not`：子条件不满足；`line`/`section`：某一行/某个标题段满足子条件。
 * - `term`：标题或正文里大小写不敏感的子串；`regex`：正则匹配。
 * - `tag`/`attr`/`path`/`file`：整篇级谓词（标签含嵌套子标签；属性值为 `null` 只要求键存在）。
 */
export type SearchExpr =
  | { kind: "and" | "or"; children: SearchExpr[] }
  | { kind: "not" | "line" | "section"; child: SearchExpr }
  | { kind: "term" | "regex" | "tag" | "path" | "file"; value: string }
  | { kind: "attr"; key: string; value: string | null };

/** 一次检索：表达式与每页文件数。 */
export type SearchQuery = {
  expr: SearchExpr;
  /** 每页文件数；非正数由内核取默认值，续页沿用相同页长。 */
  limit: number;
};

/** 融合筛选只描述元数据，不能把关键词条件当成语义硬约束。 */
export type SearchFilter =
  | { kind: "and" | "or"; children: SearchFilter[] }
  | { kind: "not"; child: SearchFilter }
  | { kind: "tag" | "path" | "file"; value: string }
  | { kind: "attr"; key: string; value: string | null };

/** 普通文本的融合请求与既有严格查询保持明确边界。 */
type HybridSearchQuery = {
  kind: "hybrid";
  text: string;
  filter: SearchFilter;
  limit: number;
};
/** 搜索入口接受严格表达式或自然语言融合请求。 */
export type SearchRequest = SearchQuery | HybridSearchQuery;
/** 模型准备与向量覆盖状态；失败必须与正常无结果区分。 */
export type SemanticStatus = {
  state: "missing" | "indexing" | "ready" | "error";
  indexed: number;
  total: number;
  message: string | null;
};
/** 相关内容的原文证据，语义段落不贡献精确命中计数。 */
export type HybridEvidence = SearchMatch & { kind: "lexical" | "fuzzy" | "semantic" };

/** 一页准确命中；不提供未经完整统计的总数，续页必须使用原查询。 */
export type SearchPage = {
  hits: SearchHit[];
  /** 仅融合查询提供语义状态与候选上限标识。 */
  semantic?: SemanticStatus;
  limited?: boolean;
  /** 绑定查询和资料库版本；null 表示已结束，资料库改变后旧游标会拒绝。 */
  nextCursor: string | null;
};

/** 单篇正文命中的下一批位置；每页最多二十处，与原结果属于同一索引版本。 */
export type SearchMatchesPage = {
  matches: SearchMatch[];
  nextCursor: string | null;
};

/** 一条搜索命中。 */
export type SearchHit = {
  /** 仅融合结果提供；包含可定位的容错与语义证据。 */
  evidence?: HybridEvidence[];
  /** 命中文件库内相对路径。 */
  path: string;
  /** 展示标题。 */
  title: string;
  /** 正文摘要；命中词以 U+0001/U+0002 控制字符包围，可能为空串。 */
  snippet: string;
  /** 与命中范围同版本的磁盘文件 SHA-256。 */
  contentHash: string;
  /** 已加载的具体正文命中；内核首批最多五处，纯谓词或仅标题命中为空。 */
  matches: SearchMatch[];
  /** 去重后的精确正文命中总数，不随展开改变。 */
  matchCount: number;
  /** 后续具体命中的不透明游标；null 表示已经全部加载。 */
  matchesCursor: string | null;
};

/** 一处命中；无法证明源码对应关系时明确缺少位置。 */
export type SearchMatch = {
  location: SearchLocation | null;
  /** 该处命中的高亮上下文。 */
  snippet: string;
};

/** 源文件同一内容版本的 UTF-8 范围；界面不能直接当作 UTF-16 下标。 */
export type SearchLocation = {
  /** 起点（含）。 */
  startByte: number;
  /** 终点（不含）。 */
  endByte: number;
  /** 源文件行号，从 1 开始。 */
  line: number;
};

/** 全库标签计数的一行。 */
export type TagCount = {
  /** 规范化标签（小写、无 `#`）。 */
  tag: string;
  /** 携带该标签的文件数。 */
  count: number;
};

/** 一条书签；存放在库内，随库同步。`title` 为空时界面按目标生成显示名。 */
export type Bookmark =
  | { kind: "file" | "folder"; path: string; title: string | null }
  | { kind: "heading"; path: string; heading: string; title: string | null }
  | { kind: "search"; query: string; title: string | null };

/** 一篇笔记可被点名的身份，供快速切换器与别名补全匹配。 */
export type NoteKeys = {
  /** 库内相对路径。 */
  path: string;
  /** 展示标题：文首一级标题，缺失时为文件名词干。 */
  title: string;
  /** frontmatter 别名，按书写顺序。 */
  aliases: string[];
};

/** 索引里的一条标题记录。 */
export type HeadingRecord = {
  /** 源文件库内相对路径。 */
  path: string;
  /** 标题等级（1–6）。 */
  level: number;
  /** 去除行内语法后的标题纯文本。 */
  text: string;
  /** 字节区间起点（含）。 */
  startByte: number;
  /** 字节区间终点（不含）。 */
  endByte: number;
};

/** 文件栏默认宽度与拖拽范围（像素）。 */
export const SIDEBAR_LAYOUT = {
  leftWidth: 232,
  minWidth: 192,
  maxWidth: 480,
};

/** 用户所在的工作空间；读写、资料与关联共用笔记库及保存契约。 */
export type ReaderSpace = "writing" | "library" | "connections";

/** 工作台目的地与文档类型独立，打开白板也属于文档页面。 */
export type WorkspaceDestination = "document" | "library";
/** 左侧内容选择；目录随当前文档，搜索结果与文档同时显示。 */
export type SidebarView = "outline" | "search";
/** @returns 是否为已知工作台目的地；未知值由恢复层迁移或回退。 */
export function isWorkspaceDestination(value: unknown): value is WorkspaceDestination {
  return value === "document" || value === "library";
}

/**
 * 会话恢复与 IPC 共用页面枚举，避免新增页面只被其中一条链路接受。
 * @param value 未经验证的页面值。
 * @returns 是否为受支持的页面；非法值返回 false，不抛出异常。
 */
export function isReaderSpace(value: unknown): value is ReaderSpace {
  return value === "writing" || value === "library" || value === "connections";
}

/** 工作空间与导航布局；旧会话缺少 space 时恢复读写空间。 */
export type PaneLayout = {
  /** 新版工作台页面；缺失时读取旧 space。 */
  destination?: WorkspaceDestination;
  /** 左栏内容及查询原文；结果不写入会话。 */
  sidebarView?: SidebarView;
  searchQuery?: string;
  /** 当前空间；可缺省以读取旧版会话。 */
  space?: ReaderSpace;
  /** 文件栏是否收起。 */
  filesCollapsed: boolean;
  /** 文件栏宽度（像素）。 */
  leftWidth: number;
};

/** 已提交的库根与完整目录；界面以同一次响应发布，避免二次读取导致半切换。 */
export type VaultOpenSnapshot = {
  /** 库根绝对路径。 */
  root: string;
  /** 提交前已准备并校验的完整目录，界面直接发布，无需再次读取。 */
  entries: VaultEntry[];
};

/** 已打开的库与用于恢复阅读现场的同一次响应。 */
export type VaultRestore = VaultOpenSnapshot & {
  /** 上次会话的分栏文档与阅读栈；渲染端按当前文件列表过滤失效条目。 */
  documents: SessionDocuments;
  /** 上次会话按文件记住的源码或阅读视图。 */
  viewModes: ViewModes;
  /** 上次会话的最近打开列表，最新在前；渲染端按当前文件列表过滤失效条目。 */
  recentFiles: string[];
  /** 同一笔记库的目录工作现场；旧会话为 null。 */
  fileTree: FileTreeState | null;
};

/** 打开文件时同时取回尚未提交的编辑，删除后的文件也能恢复。 */
export type FileSnapshot = {
  /** 当前磁盘内容；不存在或读取失败为 null，失败时附带 diskError。 */
  disk: Uint8Array | null;
  /** 仅在原路径不可读、但恢复草稿仍可返回时提供具体原因。 */
  diskError?: string;
  /** 保存失败或冲突时的草稿与基准；存在 editor 时，bytes 为源码映射基准，最新编辑由 editor 保存。 */
  draft: { bytes: Uint8Array; base: Uint8Array | null; editor?: string } | null;
};

/** 文件内容提交与派生索引失败必须分别处理。 */
export type WriteResult =
  { status: "saved"; warning: string | null } | { status: "conflict"; disk: Uint8Array | null };

/** 保留原文件后，新副本的实际位置。 */
export type SavedCopy = { path: string; warning: string | null };

/** 改名已提交，索引或恢复记录的清理可能需要重试。 */
export type RenameOutcome = { warning: string | null };

/** 文件管理条目使用库内相对路径，空文件夹也占有独立条目。 */
export type VaultEntry = {
  path: string;
  kind: "file" | "directory";
  /** 索引记录的 Unix 毫秒时间；目录和未落盘草稿缺省，不推测修改时间。 */
  modifiedAt?: number;
  /** 仅用于被目录变化阻挡的文件草稿，须与真实磁盘目录分开呈现。 */
  recoveryOnly?: true;
};

/**
 * 阅读器公开能力，由应用外壳注入；文件参数均为库内相对路径，不能访问任意文件。
 * 异步命令返回业务结果，IPC、磁盘及内核错误通过 Promise 拒绝传播给调用方。
 * 订阅返回取消函数，阅读器卸载时必须调用，避免继续接收旧实例事件。
 */
export type ReaderApi = {
  /** 隔离网页的布局与浏览控制；不会向网站提供应用或笔记库访问能力。 */
  webPages: WebPageApi;
  /** 停笔时计算规范几何；静态与原始观测共同校验，错误通过Promise拒绝。 */
  whiteboardRepair: ShapeRepair;
  /** 全栏保存门禁之后生成并提交整批导出；取消与失败具有明确结果。 */
  exportRun: (
    request: ExportRequest,
    onProgress?: (progress: ExportProgress) => void,
    onPlan?: (plan: ExportPlan) => void,
  ) => Promise<ExportResult>;
  /** 取消当前窗口导出；已进入提交边界时返回 false，不能撤销已生成文件。 */
  exportCancel: () => Promise<boolean>;
  /** 在系统文件管理器中显示本窗口最后一次成功导出的结果。 */
  exportReveal: () => Promise<void>;
  /** 启动时核实并显示未确认的导出结果，不重放生成或覆盖。 */
  exportRecover: () => Promise<void>;
  /** 弹出选目录对话框并打开库；取消时返回 `null`。 */
  vaultOpen: (
    onProgress?: (progress: VaultOpenProgress) => void,
  ) => Promise<VaultOpenSnapshot | null>;
  /** 用户首次开始记录时打开 Documents/Noemori；取消返回 null，创建失败时拒绝。 */
  vaultCreateDefault: (
    onProgress?: (progress: VaultOpenProgress) => void,
  ) => Promise<VaultOpenSnapshot | null>;
  /**
   * 用主进程记下的库路径恢复会话，不弹对话框。
   *
   * 没有保存的会话或用户取消时返回 `null`；已保存目录不可用时报告原因。
   */
  vaultRestore: (
    onProgress?: (progress: VaultOpenProgress) => void,
  ) => Promise<VaultRestore | null>;
  /** 取消当前窗口的开库准备；提交已开始或没有活动请求时返回 false。 */
  vaultOpenCancel: () => Promise<boolean>;
  /** 持久化各分栏的当前文档、阅读栈与分栏布局；路径与条目由主进程校验。 */
  sessionSetDocuments: (documents: SessionDocuments) => Promise<void>;
  /** 持久化视图记忆（源码/阅读）；损坏条目由会话解析丢弃。 */
  sessionSetViewModes: (modes: ViewModes) => Promise<void>;
  /** 持久化最近打开列表（最新在前）；损坏条目由会话解析丢弃。 */
  sessionSetRecentFiles: (paths: string[]) => Promise<void>;
  /** 写入目录现场并核对笔记库归属；切库后的过期请求拒绝。 */
  sessionSetFileTree: (root: string, state: FileTreeState) => Promise<void>;
  /** 读取文件栏布局（宽度、收起）。 */
  sessionGetPanes: () => Promise<PaneLayout>;
  /** 记住文件栏布局；不能经此改库路径或当前文件。 */
  sessionSetPanes: (panes: PaneLayout) => Promise<void>;
  /** 关闭当前库。 */
  vaultClose: () => Promise<void>;
  /** 列出库内相对路径。 */
  vaultList: () => Promise<string[]>;
  /** 完整目录快照，包含空文件夹和恢复草稿。 */
  vaultEntries: () => Promise<VaultEntry[]>;
  /** 独占创建笔记或文件夹；`content` 是随创建事务写入的文件初始字节，同名时拒绝覆盖。 */
  entryCreate: (
    path: string,
    kind: VaultEntry["kind"],
    content?: Uint8Array,
  ) => Promise<RenameOutcome>;
  /** 导入用户选择的字节到笔记旁；root 必须仍是活动库，同名文件自动避让。 */
  attachmentImport: (
    root: string,
    from: string,
    name: string,
    bytes: Uint8Array,
  ) => Promise<ImportedAttachment>;
  /** 移入系统废纸篓；有未处理草稿时拒绝，绝不永久删除。 */
  entryTrash: (path: string) => Promise<RenameOutcome>;
  /** 一次保存门禁对应一批请求；部分成功以结构化结果返回，剩余项可重试。 */
  entryBatch: (
    request: EntryBatchRequest,
    onProgress?: (progress: EntryBatchProgress) => void,
  ) => Promise<EntryBatchResult>;
  /** 请求停止当前库的活动批次；当前条目提交后返回剩余项，不中断写盘。 */
  entryBatchStop: (root: string) => Promise<void>;
  /** 在系统文件管理器中定位已校验的库内条目。 */
  entryReveal: (path: string) => Promise<void>;
  /** 读取原始字节。 */
  fileRead: (rel: string) => Promise<Uint8Array>;
  /** 加载编辑器快照，包括可恢复草稿。 */
  fileSnapshot: (rel: string) => Promise<FileSnapshot>;
  /** 只写恢复记录；source 是会话原始源码，editor 是带版本的最新编辑，不能写入 Markdown。 */
  filePreserveDraft: (
    rel: string,
    source: Uint8Array,
    expected: Uint8Array | null,
    editor: string,
  ) => Promise<void>;
  /** 核对 expected 后原子提交；null 仅允许创建新文件。 */
  fileWrite: (rel: string, bytes: Uint8Array, expected: Uint8Array | null) => Promise<WriteResult>;
  /** 独占创建同目录副本，保留原文件和已有副本。 */
  fileWriteCopy: (
    rel: string,
    bytes: Uint8Array,
    expected: Uint8Array | null,
  ) => Promise<SavedCopy>;
  /** 解析内部链接：路径、锚点与歧义候选。 */
  linksResolve: (from: string, raw: string, kind: LinkKind) => Promise<LinkTarget>;
  /** 用户点击后用系统应用打开网页或邮件链接；无效地址和非允许协议拒绝。 */
  openExternal: (url: string) => Promise<void>;
  /** 入链。 */
  indexLinksTo: (path: string) => Promise<LinkRecord[]>;
  /** 已链接与未链接提及。 */
  indexMentionsTo: (path: string) => Promise<Mentions>;
  /**
   * 把 `from` 文件里的未链接提及就地转为指向 `target` 的 wiki 链接。
   *
   * 区间与 `expected` 文本来自提及查询；文件已变化时内核拒绝改写。
   */
  mentionsLinkify: (
    from: string,
    startByte: number,
    endByte: number,
    expected: string,
    target: string,
  ) => Promise<RenameOutcome>;
  /** 出链。 */
  indexLinksFrom: (path: string) => Promise<LinkRecord[]>;
  /** 结构化全文搜索：正文词、标签、属性与路径谓词组合。 */
  searchQuery: (query: SearchRequest, id: string, cursor: string | null) => Promise<SearchPage>;
  /** 在同一搜索会话内加载更多具体命中；版本变化或已取消时拒绝。 */
  searchMatches: (query: SearchRequest, id: string, cursor: string) => Promise<SearchMatchesPage>;
  /** 下载固定语义模型并索引当前库；import 时由主进程选择本地模型目录。 */
  searchModelInstall: (mode: "download" | "import", id: string) => Promise<SemanticStatus | null>;
  /** 只取消模型下载或导入，保留当前查询和已提交模型。 */
  searchModelCancel: (id: string) => Promise<void>;
  /** 取消指定查询；迟到的取消不影响后发查询，已完成或关闭时幂等。 */
  searchCancel: (id: string) => Promise<void>;
  /** 一篇文件的全部标题，按文档顺序；供锚点解析与标题补全。 */
  indexHeadings: (path: string) => Promise<HeadingRecord[]>;
  /** 全库标签及计数，标签升序；供标签浏览面板。 */
  indexTags: () => Promise<TagCount[]>;
  /** 全部 Markdown 笔记的标题与别名，路径升序；供快速切换器与别名补全。 */
  indexNoteKeys: () => Promise<NoteKeys[]>;
  /** 读出库内书签；书签文件损坏时拒绝，界面显示原因。 */
  bookmarksList: () => Promise<Bookmark[]>;
  /** 整体替换书签清单；损坏的旧文件先备份再覆盖。 */
  bookmarksSet: (items: Bookmark[]) => Promise<void>;
  /** 改名并更新链接。 */
  entryRename: (from: string, to: string) => Promise<RenameOutcome>;
  /**
   * 订阅库文件变更（监视防抖后）。
   *
   * @returns 取消订阅。
   */
  subscribeVaultChanged: (callback: (event: VaultEvent) => void) => () => void;
};
