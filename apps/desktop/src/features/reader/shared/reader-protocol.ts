import type {
  Bookmark,
  GraphEdge,
  GraphNode,
  HeadingRecord,
  LinkKind,
  LinkRecord,
  LinkTarget,
  MentionRecord,
  Mentions,
  NoteKeys,
  PaneLayout,
  RenameOutcome,
  SavedCopy,
  SearchExpr,
  SearchHit,
  SearchPage,
  SearchMatch,
  SearchMatchesPage,
  SearchQuery,
  TagCount,
  VaultEntry,
  VaultGraph,
  VaultRestore,
  WriteResult,
} from "./api";
import { SIDEBAR_LAYOUT } from "./api";
import { parseFileTreeState } from "./file-browser";
import {
  parseRecentFiles,
  parseSessionDocuments,
  parseViewModes,
  type SessionDocuments,
} from "./session";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warning(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function path(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function relativePath(value: unknown): value is string {
  return (
    path(value) && !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function byteOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 字节偏移参数必须是非负安全整数；损坏区间不能进入内核改写。 */
export function parseByteArgument(value: unknown): number {
  if (!byteOffset(value)) throw new Error("提及定位范围无效");
  return value;
}

/** 校验跨进程路径参数的类型；相对路径、符号链接与库根约束仍由内核统一执行。 */
export function parsePathArgument(value: unknown): string {
  if (!path(value)) throw new Error("文件路径必须是非空文本且不含空字符");
  return value;
}

/** 接受完整的字节视图，包括空文件；拒绝数组、字符串及隐式 Buffer 转换。 */
export function parseFileBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("文件内容不是有效字节");
  return value;
}

/** 可选字节内容；`null`/`undefined` 视为缺席，其余按严格字节校验。 */
export function parseOptionalBytes(value: unknown): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  return parseFileBytes(value);
}

/** 保存必须携带目标字节和明确的磁盘基准；null 仅表示预期文件不存在。 */
export function parseWriteRequest(rel: unknown, bytes: unknown, expected: unknown) {
  return {
    rel: parsePathArgument(rel),
    bytes: parseFileBytes(bytes),
    expected: expected === null ? null : parseFileBytes(expected),
  };
}

/** 只接受已知的保存分支；无效确认抛错，让文档保留编辑和原磁盘基准。 */
export function parseWriteResult(value: unknown): WriteResult {
  if (record(value)) {
    if (value.status === "saved" && warning(value.warning))
      return { status: "saved", warning: value.warning };
    if (value.status === "conflict" && (value.disk === null || value.disk instanceof Uint8Array))
      return { status: "conflict", disk: value.disk };
  }
  throw new Error("无法确认保存结果，当前编辑仍保留；请检查磁盘内容后重试");
}

/** 副本位置和提交后警告必须完整；失败时不允许切换当前文档或更新保存基准。 */
export function parseSavedCopy(value: unknown): SavedCopy {
  if (record(value) && relativePath(value.path) && warning(value.warning))
    return { path: value.path, warning: value.warning };
  throw new Error("无法确认副本保存结果，当前编辑仍保留；请检查文件栏中的副本后重试");
}

/** 创建、改名、移动和废纸篓操作共享提交后警告；不能把无效返回值当成成功。 */
export function parseEntryOutcome(value: unknown): RenameOutcome {
  if (record(value) && warning(value.warning)) return { warning: value.warning };
  throw new Error("无法确认文件操作结果，请刷新文件栏检查实际条目后重试");
}

/** 无数据命令也必须返回空确认；错误结果不能经 Promise<void> 断言被忽略。 */
export function parseEmptyReply(value: unknown): void {
  if (value !== undefined) throw new Error("未收到有效的操作确认，请检查操作结果后重试");
}

/** 路径只接受明确文本或 null；错误参数不能被解释成关闭文档、取消或未命中。 */
export function parseNullablePath(value: unknown): string | null {
  return value === null ? null : parsePathArgument(value);
}

/**
 * 链接解析响应按状态判别：resolved 必须带有效库内路径，ambiguous 必须带
 * 非空候选列表；空锚点归一化为 null，损坏响应整体拒绝而不是退化成死链。
 */
export function parseLinkTarget(value: unknown): LinkTarget {
  if (record(value)) {
    let anchor: string | null = null;
    if (value.anchor !== undefined && value.anchor !== null) {
      if (typeof value.anchor !== "string") throw new Error("链接解析响应无效");
      if (value.anchor !== "") anchor = value.anchor;
    }
    if (value.status === "resolved" && relativePath(value.path))
      return { status: "resolved", path: value.path, anchor };
    if (
      value.status === "ambiguous" &&
      Array.isArray(value.candidates) &&
      value.candidates.length > 0 &&
      value.candidates.every((candidate: unknown) => relativePath(candidate))
    )
      return { status: "ambiguous", candidates: value.candidates, anchor };
    if (value.status === "dead") return { status: "dead" };
  }
  throw new Error("链接解析响应无效");
}

/**
 * 校验渲染进程写回的文档会话。
 *
 * 会话文件可以宽容损坏条目；这条通道相反：缺栏或非法路径必须拒绝，
 * 否则空对象会把当前笔记清空。
 *
 * @param value IPC 传入的未知值。
 * @returns 归一化后的分栏会话。
 * @throws 不是对象、没有分栏数组，或某栏路径不合法时抛出。
 */
export function parseSessionDocumentsMessage(value: unknown): SessionDocuments {
  if (!record(value) || !Array.isArray(value.panes)) throw new Error("文档会话无效");
  const documents = parseSessionDocuments(value);
  for (const pane of documents.panes) {
    if (pane.currentPath !== null && !relativePath(pane.currentPath))
      throw new Error("文档会话包含无效路径");
  }
  return documents;
}

/** 恢复库路径与文档会话必须来自同一个完整响应；无效响应抛错，不伪装成空库。 */
export function parseVaultRestore(value: unknown): VaultRestore | null {
  if (value === null) return null;
  if (record(value) && path(value.root)) {
    if (!record(value.documents)) throw new Error("笔记库恢复响应无效，请重新打开笔记库");
    const documents = parseSessionDocuments(value.documents);
    // 分栏路径必须是规范库内相对路径；损坏时整体拒绝而不是丢栏。
    for (const pane of documents.panes) {
      if (pane.currentPath !== null && !relativePath(pane.currentPath))
        throw new Error("笔记库恢复响应无效，请重新打开笔记库");
    }
    return {
      root: value.root,
      documents,
      // 视图记忆与最近列表是恢复性数据：损坏条目按会话解析规则丢弃，不拒绝整个恢复。
      viewModes: parseViewModes(value.viewModes),
      recentFiles: parseRecentFiles(value.recentFiles),
      fileTree: parseFileTreeState(value.fileTree),
    };
  }
  throw new Error("笔记库恢复响应无效，请重新打开笔记库");
}

/** 文件列表逐项校验，拒绝半份无效结果，避免文件栏漏项或指向错误条目。 */
export function parseVaultList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("文件列表响应无效");
  return value.map((item: unknown) => {
    if (!relativePath(item)) throw new Error("文件列表包含无效的库内路径");
    return item;
  });
}

/** 文件种类必须明确；未知值不能被内核或调用端猜测为文件夹。 */
export function parseEntryKind(value: unknown): VaultEntry["kind"] {
  if (value !== "file" && value !== "directory") throw new Error("未知的文件条目类型");
  return value;
}

/** 完整目录快照只允许恢复文件使用 recoveryOnly，未知结构拒绝传播。 */
export function parseVaultEntries(value: unknown): VaultEntry[] {
  if (!Array.isArray(value)) throw new Error("目录快照响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.path) ||
      (item.kind !== "file" && item.kind !== "directory") ||
      ("recoveryOnly" in item && (item.recoveryOnly !== true || item.kind !== "file"))
    )
      throw new Error("目录快照包含无效条目");
    return {
      path: item.path,
      kind: item.kind,
      ...("recoveryOnly" in item ? { recoveryOnly: true as const } : {}),
    };
  });
}

/** IPC 布局必须完整且在允许范围；会话文件的旧格式兼容仍由会话解析负责。 */
export function parsePaneLayoutMessage(value: unknown): PaneLayout {
  if (
    !record(value) ||
    typeof value.filesCollapsed !== "boolean" ||
    typeof value.leftWidth !== "number" ||
    !Number.isFinite(value.leftWidth) ||
    value.leftWidth < SIDEBAR_LAYOUT.minWidth ||
    value.leftWidth > SIDEBAR_LAYOUT.maxWidth ||
    (value.space !== undefined && value.space !== "writing" && value.space !== "library")
  )
    throw new Error("文件栏布局参数无效");
  return {
    filesCollapsed: value.filesCollapsed,
    leftWidth: Math.round(value.leftWidth),
    ...(value.space === undefined ? {} : { space: value.space }),
  };
}

/** 链接种类不允许回退；错误种类可能把双链按另一种语法解析到错误文件。 */
export function parseLinkKindArgument(value: unknown): LinkKind {
  if (value !== "wiki" && value !== "md") throw new Error("未知的链接语法");
  return value;
}

/** 索引解析状态不允许回退；缺字段会把死链和歧义混成同一种未解析。 */
function linkResolution(value: unknown): value is "resolved" | "ambiguous" | "dead" | "self" {
  return value === "resolved" || value === "ambiguous" || value === "dead" || value === "self";
}

/** 链接原文允许空字符串，由内核按语法决定是否可解析；其他值必须拒绝。 */
export function parseLinkText(value: unknown): string {
  if (typeof value !== "string") throw new Error("链接目标必须是文本");
  return value;
}

/** 校验原文目标、已解析路径与字节范围，不把错误索引数据强转为导航位置。 */
export function parseLinkRecords(value: unknown): LinkRecord[] {
  if (!Array.isArray(value)) throw new Error("链接索引响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.fromPath) ||
      typeof item.toRaw !== "string" ||
      (item.toPath !== null && !relativePath(item.toPath)) ||
      (item.kind !== "wiki" && item.kind !== "md") ||
      !linkResolution(item.resolution) ||
      !byteOffset(item.startByte) ||
      !byteOffset(item.endByte) ||
      item.endByte < item.startByte
    )
      throw new Error("链接索引包含无效路径、语法或定位范围");
    return {
      fromPath: item.fromPath,
      toRaw: item.toRaw,
      toPath: item.toPath,
      kind: item.kind,
      resolution: item.resolution,
      startByte: item.startByte,
      endByte: item.endByte,
    };
  });
}

function parseMention(value: unknown, kind: "linked" | "unlinked"): MentionRecord {
  if (
    !record(value) ||
    !relativePath(value.fromPath) ||
    typeof value.fromTitle !== "string" ||
    typeof value.snippet !== "string" ||
    typeof value.toRaw !== "string" ||
    value.kind !== kind ||
    typeof value.mtime !== "number" ||
    !Number.isFinite(value.mtime) ||
    !byteOffset(value.startByte) ||
    !byteOffset(value.endByte) ||
    value.endByte < value.startByte ||
    (kind === "linked"
      ? value.linkKind !== "wiki" && value.linkKind !== "md"
      : value.linkKind !== null)
  )
    throw new Error("提及索引包含无效来源、语法或定位范围");
  return {
    fromPath: value.fromPath,
    fromTitle: value.fromTitle,
    snippet: value.snippet,
    toRaw: value.toRaw,
    kind,
    mtime: value.mtime,
    startByte: value.startByte,
    endByte: value.endByte,
    linkKind: parseNullableLinkKind(value.linkKind),
  };
}

function parseNullableLinkKind(value: unknown): LinkKind | null {
  return value === null ? null : parseLinkKindArgument(value);
}

/** 两组提及的种类与字段必须一致；损坏数据整体拒绝，由引用面板显示可恢复错误。 */
export function parseMentions(value: unknown): Mentions {
  if (!record(value) || !Array.isArray(value.linked) || !Array.isArray(value.unlinked))
    throw new Error("提及索引响应无效");
  return {
    linked: value.linked.map((item: unknown) => parseMention(item, "linked")),
    unlinked: value.unlinked.map((item: unknown) => parseMention(item, "unlinked")),
  };
}

/** 检索表达式的嵌套深度上限；查询框手写不会接近，超出视为损坏或恶意输入。 */
export const SEARCH_DEPTH_LIMIT = 32;
/** 检索表达式的节点总数上限。 */
export const SEARCH_NODE_LIMIT = 256;

/**
 * 校验结构化检索条件；查询文本的解析发生在渲染层，主进程不接受原始查询串。
 *
 * 表达式逐节点校验种类与字段，深度与节点数设上限，避免病态输入在内核里递归求值。
 * `limit` 截断为整数并压到 0–500：0 由内核解释为默认上限，超出内核对 `i32`
 * 的表示范围会在原生边界报错，必须提前收敛。
 */
export function parseSearchQueryArgument(value: unknown): SearchQuery {
  if (!record(value)) throw new Error("检索条件无效");
  if (typeof value.limit !== "number" || !Number.isFinite(value.limit))
    throw new Error("检索条件的结果上限无效");
  const budget = { nodes: 0 };
  return {
    expr: parseSearchExpr(value.expr, 0, budget),
    limit: Math.max(0, Math.min(Math.trunc(value.limit), 500)),
  };
}

function parseSearchExpr(value: unknown, depth: number, budget: { nodes: number }): SearchExpr {
  if (depth > SEARCH_DEPTH_LIMIT) throw new Error("检索条件嵌套过深");
  budget.nodes += 1;
  if (budget.nodes > SEARCH_NODE_LIMIT) throw new Error("检索条件过于复杂");
  if (!record(value)) throw new Error("检索条件无效");
  switch (value.kind) {
    case "and":
    case "or":
      if (!Array.isArray(value.children)) throw new Error("检索条件的子条件必须是列表");
      return {
        kind: value.kind,
        children: value.children.map((child: unknown) => parseSearchExpr(child, depth + 1, budget)),
      };
    case "not":
    case "line":
    case "section":
      return { kind: value.kind, child: parseSearchExpr(value.child, depth + 1, budget) };
    case "term":
    case "regex":
    case "tag":
    case "path":
    case "file":
      if (typeof value.value !== "string") throw new Error("检索条件的值必须是文本");
      return { kind: value.kind, value: value.value };
    case "attr":
      if (
        typeof value.key !== "string" ||
        (value.value !== null && typeof value.value !== "string")
      )
        throw new Error("属性谓词必须是键与文本值");
      return { kind: "attr", key: value.key, value: value.value };
    default:
      throw new Error("未知的检索条件种类");
  }
}

/** 检索命中逐项校验；摘要里的控制字符是合法的命中标记，不做过滤。 */
export function parseSearchHits(value: unknown): SearchHit[] {
  if (!Array.isArray(value)) throw new Error("检索响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.path) ||
      typeof item.title !== "string" ||
      typeof item.snippet !== "string" ||
      typeof item.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.contentHash) ||
      !Array.isArray(item.matches) ||
      item.matches.length > 5 ||
      typeof item.matchCount !== "number" ||
      !Number.isSafeInteger(item.matchCount) ||
      item.matchCount < item.matches.length
    )
      throw new Error("检索命中的路径、文本、内容版本或匹配列表无效");
    const matchesCursor = parseSearchCursor(item.matchesCursor);
    if (
      matchesCursor === null
        ? item.matchCount !== item.matches.length
        : item.matches.length !== 5 || item.matchCount <= 5
    )
      throw new Error("检索命中总数与续页不一致");
    return {
      path: item.path,
      title: item.title,
      snippet: item.snippet,
      contentHash: item.contentHash,
      matches: item.matches.map(parseSearchMatch),
      matchCount: item.matchCount,
      matchesCursor,
    };
  });
}

/** 搜索任务 ID 由调用方预先生成，限制长度和字符以保证跨进程身份稳定；无效时拒绝。 */
export function parseSearchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("搜索请求标识无效");
  return value;
}

/** 续页游标仅原样转交内核校验；null 表示新查询，禁止无限长度的外部输入。 */
export function parseSearchCursor(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > 8192
  )
    throw new Error("搜索续页游标无效");
  return value;
}

/** 单篇续页必须携带已证明存在后续命中的游标；null 不能启动新的命中查询。 */
export function parseSearchMatchesCursor(value: unknown): string {
  const cursor = parseSearchCursor(value);
  if (cursor === null) throw new Error("搜索命中续页游标无效");
  return cursor;
}

/** 验证命中续页的大小及结束标识，空页不能冒充成功续页。 */
export function parseSearchMatchesPage(value: unknown): SearchMatchesPage {
  if (
    !record(value) ||
    !Array.isArray(value.matches) ||
    value.matches.length < 1 ||
    value.matches.length > 20
  )
    throw new Error("搜索命中分页响应无效");
  const matches = value.matches.map(parseSearchMatch);
  const nextCursor = parseSearchCursor(value.nextCursor);
  if (nextCursor !== null && matches.length !== 20) throw new Error("搜索命中分页未填满");
  return { matches, nextCursor };
}

/** 校验整页结果；重复路径或空页携带续页都违反文件分页契约。 */
export function parseSearchPage(value: unknown): SearchPage {
  if (!record(value)) throw new Error("搜索分页响应无效");
  const hits = parseSearchHits(value.hits);
  const nextCursor = parseSearchCursor(value.nextCursor);
  if (
    new Set(hits.map((hit) => hit.path)).size !== hits.length ||
    (hits.length === 0 && nextCursor !== null)
  )
    throw new Error("搜索分页结果重复或续页无效");
  return { hits, nextCursor };
}

function parseSearchMatch(value: unknown): SearchMatch {
  if (!record(value) || typeof value.snippet !== "string") throw new Error("检索命中上下文无效");
  const location = value.location;
  if (location === null) return { location: null, snippet: value.snippet };
  if (
    !record(location) ||
    typeof location.startByte !== "number" ||
    !Number.isSafeInteger(location.startByte) ||
    location.startByte < 0 ||
    typeof location.endByte !== "number" ||
    !Number.isSafeInteger(location.endByte) ||
    location.endByte <= location.startByte ||
    typeof location.line !== "number" ||
    !Number.isSafeInteger(location.line) ||
    location.line < 1
  )
    throw new Error("检索命中位置无效");
  return {
    snippet: value.snippet,
    location: { startByte: location.startByte, endByte: location.endByte, line: location.line },
  };
}

/** 标签计数逐项校验；损坏数据整体拒绝，不渲染半份清单。 */
export function parseTagCounts(value: unknown): TagCount[] {
  if (!Array.isArray(value)) throw new Error("标签清单响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.tag !== "string" ||
      item.tag === "" ||
      typeof item.count !== "number" ||
      !Number.isSafeInteger(item.count) ||
      item.count < 0
    )
      throw new Error("标签清单包含无效的标签或计数");
    return { tag: item.tag, count: item.count };
  });
}

/**
 * 图谱逐项校验。
 *
 * 笔记节点必须是规范库内相对路径（点击会直接打开）；死链节点只要求非空文本。
 * 边必须引用已列出的节点且计数为正整数，界面据此建立邻接表而不再做存在性检查。
 */
export function parseGraph(value: unknown): VaultGraph {
  if (!record(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges))
    throw new Error("图谱无效");
  const paths = new Set<string>();
  const nodes = value.nodes.map((node: unknown): GraphNode => {
    if (
      !record(node) ||
      typeof node.dead !== "boolean" ||
      typeof node.path !== "string" ||
      (node.dead ? node.path === "" : !relativePath(node.path)) ||
      typeof node.title !== "string" ||
      !Array.isArray(node.tags) ||
      !node.tags.every((tag) => typeof tag === "string") ||
      paths.has(node.path)
    )
      throw new Error("图谱节点无效");
    paths.add(node.path);
    return { path: node.path, title: node.title, tags: [...node.tags], dead: node.dead };
  });
  const edges = value.edges.map((edge: unknown): GraphEdge => {
    if (
      !record(edge) ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      !paths.has(edge.from) ||
      !paths.has(edge.to) ||
      typeof edge.count !== "number" ||
      !Number.isSafeInteger(edge.count) ||
      edge.count < 1
    )
      throw new Error("图谱边无效");
    return { from: edge.from, to: edge.to, count: edge.count };
  });
  return { nodes, edges };
}

/** 书签清单上限；只防病态输入，手工整理远达不到。 */
export const BOOKMARK_LIMIT = 1000;

/**
 * 书签逐项校验；请求与响应共用。
 *
 * 路径必须是规范库内相对路径，文本字段必须非空；多余字段不透传。
 * 损坏数据整体拒绝，不渲染半份清单，也不把越界路径写进库。
 */
export function parseBookmarks(value: unknown): Bookmark[] {
  if (!Array.isArray(value) || value.length > BOOKMARK_LIMIT) throw new Error("书签清单无效");
  return value.map((item: unknown): Bookmark => {
    if (!record(item) || (item.title !== null && typeof item.title !== "string"))
      throw new Error("书签字段无效");
    const title = item.title;
    switch (item.kind) {
      case "file":
      case "folder":
        if (!relativePath(item.path)) throw new Error("书签路径无效");
        return { kind: item.kind, path: item.path, title };
      case "heading":
        if (!relativePath(item.path) || typeof item.heading !== "string" || item.heading === "")
          throw new Error("标题书签无效");
        return { kind: "heading", path: item.path, heading: item.heading, title };
      case "search":
        if (typeof item.query !== "string" || item.query.trim() === "")
          throw new Error("搜索书签无效");
        return { kind: "search", query: item.query, title };
      default:
        throw new Error("未知的书签种类");
    }
  });
}

/** 笔记身份逐项校验；损坏数据整体拒绝，不让快速切换器打开越界路径。 */
export function parseNoteKeys(value: unknown): NoteKeys[] {
  if (!Array.isArray(value)) throw new Error("笔记身份响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.path) ||
      typeof item.title !== "string" ||
      !stringArray(item.aliases)
    )
      throw new Error("笔记身份包含无效路径、标题或别名");
    return { path: item.path, title: item.title, aliases: [...item.aliases] };
  });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

/** 标题记录逐项校验；字节区间将被映射为编辑器位置，损坏数据必须整体拒绝。 */
export function parseHeadingRecords(value: unknown): HeadingRecord[] {
  if (!Array.isArray(value)) throw new Error("标题索引响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.path) ||
      typeof item.level !== "number" ||
      !Number.isInteger(item.level) ||
      item.level < 1 ||
      item.level > 6 ||
      typeof item.text !== "string" ||
      !byteOffset(item.startByte) ||
      !byteOffset(item.endByte) ||
      item.endByte < item.startByte
    )
      throw new Error("标题索引包含无效等级或定位范围");
    return {
      path: item.path,
      level: item.level,
      text: item.text,
      startByte: item.startByte,
      endByte: item.endByte,
    };
  });
}
