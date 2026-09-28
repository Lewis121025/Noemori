/** 阅读器会话只记录笔记库、当前文件、文件栏与阅读栈，不包含主题或窗口几何。 */
import { SIDEBAR_LAYOUT, type PaneLayout } from "./api";
import { parseFileTreeState, type FileTreeState } from "./file-browser";
import { parseReadingBookmark, type ReadingBookmark } from "./reading-position";

/** 文件栏默认宽度（像素）。 */
export const DEFAULT_LEFT_WIDTH = SIDEBAR_LAYOUT.leftWidth;

/** 阅读栈持久化上限；超长历史没有恢复价值，防止会话文件无限增长。 */
export const HISTORY_LIMIT = 100;

/** 视图记忆条数上限；只防会话文件病态增长，正常库远达不到。 */
export const VIEW_MODE_LIMIT = 500;

/** 需要记住的 Markdown 视图；排版视图是默认值，不写入记忆。 */
export type RememberedView = "source" | "reading";

/** 按库内路径记住的视图选择。 */
export type ViewModes = Record<string, RememberedView>;

/** 最近打开列表上限；快速切换器空查询只需要近期落点。 */
export const RECENT_FILES_LIMIT = 50;

/** 阅读栈条目：一次导航落点及可跨布局恢复的正文锚点。 */
export type HistoryEntry = {
  /** 库内相对路径。 */
  path: string;
  /** 落点标题锚点；无锚点为 `null`。 */
  anchor: string | null;
  /** 离开时实际读到的正文位置；旧记录仅包含标题锚点。 */
  position?: ReadingBookmark;
};

/** 阅读栈的双向持久化形态。 */
export type SessionHistory = {
  /** 后退栈，栈顶是上一个位置。 */
  back: HistoryEntry[];
  /** 前进栈，栈顶是下一个位置。 */
  forward: HistoryEntry[];
};

/** 单个分栏的持久化形态。 */
export type PaneSession = {
  /** 该栏打开文件的库内相对路径；空栏为 `null`。 */
  currentPath: string | null;
  /** 该栏的阅读栈。 */
  history: SessionHistory;
  /** 当前正文的阅读锚点；旧会话或不可定位的附件不包含此字段。 */
  position?: ReadingBookmark;
};

/** 文档会话：分栏集合、活动栏与分栏开关。 */
export type SessionDocuments = {
  /** 1–2 个分栏；下标即栏位。 */
  panes: PaneSession[];
  /** 活动栏下标。 */
  active: number;
  /** 是否分栏显示。 */
  split: boolean;
};

/** 单栏空文档会话。 */
export function emptyPaneSession(): PaneSession {
  return { currentPath: null, history: { back: [], forward: [] } };
}

/** 单栏空文档会话集合。 */
export function emptySessionDocuments(): SessionDocuments {
  return { panes: [emptyPaneSession()], active: 0, split: false };
}

/** 阅读器独立恢复状态。 */
export type ReaderSession = PaneLayout & {
  /** 当前笔记库的绝对路径。 */
  vaultRoot: string | null;
  /** 各分栏的文档与阅读栈；切库时重置为单栏。 */
  documents: SessionDocuments;
  /** 按文件记住的源码或阅读视图；切库时清空。 */
  viewModes: ViewModes;
  /** 最近打开的文件，最新在前；切库时清空。 */
  recentFiles: string[];
  /** 文件树的展开、选择与滚动锚点；缺席表示首次定位当前文档。 */
  fileTree: FileTreeState | null;
};

/** 缺失或损坏的阅读器状态从空笔记库开始。 */
export const emptyReaderSession: ReaderSession = {
  vaultRoot: null,
  documents: emptySessionDocuments(),
  filesCollapsed: false,
  leftWidth: DEFAULT_LEFT_WIDTH,
  viewModes: {},
  recentFiles: [],
  fileTree: null,
};

function parseCollapsed(value: unknown): boolean {
  return value === true;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function clampWidth(value: unknown, fallback: number): number {
  if (!(typeof value === "number" && Number.isFinite(value))) {
    return fallback;
  }
  return Math.min(SIDEBAR_LAYOUT.maxWidth, Math.max(SIDEBAR_LAYOUT.minWidth, Math.round(value)));
}

/**
 * 只认侧栏布局字段。忽略 `vaultRoot` / `currentPath`，避免渲染进程经 setPanes 改库路径。
 *
 * @param value IPC 传入的未知对象。
 * @returns 合法布局；非对象为 `null`。
 */
export function parsePaneLayout(value: unknown): PaneLayout | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    filesCollapsed: parseCollapsed(record.filesCollapsed),
    leftWidth: clampWidth(record.leftWidth, DEFAULT_LEFT_WIDTH),
    ...(record.space === "writing" || record.space === "library" ? { space: record.space } : {}),
  };
}

function parseHistoryEntries(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryEntry[] = [];
  for (const item of value.slice(0, HISTORY_LIMIT)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path === "") continue;
    const anchor = typeof record.anchor === "string" && record.anchor !== "" ? record.anchor : null;
    const position = parseReadingBookmark(record.position);
    out.push({ path: record.path, anchor, ...(position === null ? {} : { position }) });
  }
  return out;
}

/**
 * 归一化阅读栈：无效条目静默丢弃，长度压到上限。
 *
 * 会话文件是恢复性数据，损坏条目不该阻止整个会话恢复。
 */
export function parseSessionHistory(value: unknown): SessionHistory {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { back: [], forward: [] };
  const record = value as Record<string, unknown>;
  return {
    back: parseHistoryEntries(record.back),
    forward: parseHistoryEntries(record.forward),
  };
}

/**
 * 归一化路径列表：只留非空文本，保序去重并截到上限。
 *
 * 会话是恢复性数据，损坏条目静默丢弃而不是拒绝整个会话。
 */
function parsePathList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "" || out.includes(item)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 归一化视图记忆：只留非空路径与已知视图，截到上限。
 *
 * @param value 会话或 IPC 里的视图记忆。
 * @param legacy 旧版会话的 `sourceViews` 路径列表；新字段缺席时迁移为源码视图。
 * 会话是恢复性数据，损坏条目静默丢弃而不是拒绝整个会话。
 */
export function parseViewModes(value: unknown, legacy?: unknown): ViewModes {
  const out: ViewModes = {};
  let count = 0;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [path, mode] of Object.entries(value)) {
      if (path === "" || (mode !== "source" && mode !== "reading")) continue;
      out[path] = mode;
      if (++count >= VIEW_MODE_LIMIT) break;
    }
    return out;
  }
  for (const path of parsePathList(legacy, VIEW_MODE_LIMIT)) out[path] = "source";
  return out;
}

/**
 * 视图记忆跟随改名或删除迁移。
 *
 * @param mapPath 与当前文档同口径的映射；返回 null 表示条目移除。
 * @returns 迁移后的记忆；没有任何变化时返回 null，避免无谓的会话重写。
 */
export function mapViewModes(
  modes: Readonly<ViewModes>,
  mapPath: (path: string) => string | null,
): ViewModes | null {
  let changed = false;
  const out: ViewModes = {};
  for (const [path, mode] of Object.entries(modes)) {
    const mapped = mapPath(path);
    if (mapped !== path) changed = true;
    if (mapped !== null) out[mapped] = mode;
  }
  return changed ? out : null;
}

/** 归一化最近打开列表，保持最新在前的顺序；规则见 {@link parsePathList}。 */
export function parseRecentFiles(value: unknown): string[] {
  return parsePathList(value, RECENT_FILES_LIMIT);
}

/**
 * 把刚打开的文件置顶。
 *
 * @param recent 当前最近列表，最新在前。
 * @param path 刚打开的库内路径。
 * @returns 新列表；原列表不变，超出上限丢最旧。
 */
export function pushRecentFile(recent: readonly string[], path: string): string[] {
  return [path, ...recent.filter((item) => item !== path)].slice(0, RECENT_FILES_LIMIT);
}

/**
 * 路径列表跟随改名或删除迁移。
 *
 * @param paths 会话里的路径列表。
 * @param mapPath 与当前文档同口径的映射；返回 null 表示条目移除。
 * @returns 迁移后的列表；没有任何变化时返回 null，避免无谓的会话重写。
 */
export function mapPathList(
  paths: readonly string[],
  mapPath: (path: string) => string | null,
): string[] | null {
  let changed = false;
  const out = paths.flatMap((entry) => {
    const path = mapPath(entry);
    if (path === null) {
      changed = true;
      return [];
    }
    if (path !== entry) changed = true;
    return [path];
  });
  return changed ? out : null;
}

/** 分栏数量上限；界面只提供双栏，多余条目丢弃。 */
export const PANE_LIMIT = 2;

function parsePaneSession(value: unknown): PaneSession {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return emptyPaneSession();
  const record = value as Record<string, unknown>;
  const currentPath = parseNullableString(record.currentPath);
  const position = currentPath === null ? null : parseReadingBookmark(record.position);
  return {
    currentPath,
    history: parseSessionHistory(record.history),
    ...(position === null ? {} : { position }),
  };
}

/**
 * 归一化文档会话；旧版单文档字段（currentPath/history）迁移为单栏。
 *
 * 会话是恢复性数据：损坏条目丢弃而不是拒绝整个会话。
 */
export function parseSessionDocuments(
  value: unknown,
  legacy?: Record<string, unknown>,
): SessionDocuments {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.panes)) {
      const panes = record.panes.slice(0, PANE_LIMIT).map(parsePaneSession);
      if (panes.length === 0) panes.push(emptyPaneSession());
      const active =
        typeof record.active === "number" &&
        Number.isInteger(record.active) &&
        record.active >= 0 &&
        record.active < panes.length
          ? record.active
          : 0;
      const split = record.split === true && panes.length === PANE_LIMIT;
      return { panes, active, split };
    }
  }
  if (legacy !== undefined) {
    return {
      panes: [
        {
          currentPath: parseNullableString(legacy.currentPath),
          history: parseSessionHistory(legacy.history),
        },
      ],
      active: 0,
      split: false,
    };
  }
  return emptySessionDocuments();
}

/**
 * 归一化阅读器状态，忽略历史分栏与钉住字段。
 * @param value 从应用会话读取的 JSON 值。
 * @returns 独立的阅读器状态；非对象返回默认值，非法宽度回退或限制在允许范围。
 */
export function parseReaderSession(value: unknown): ReaderSession {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {
      ...emptyReaderSession,
      documents: emptySessionDocuments(),
      viewModes: {},
      recentFiles: [],
    };
  const record = value as Record<string, unknown>;
  return {
    vaultRoot: parseNullableString(record.vaultRoot),
    documents: parseSessionDocuments(record.documents, record),
    // 旧版只记源码视图的路径列表；新字段缺席时迁移过来。
    viewModes: parseViewModes(record.viewModes, record.sourceViews),
    recentFiles: parseRecentFiles(record.recentFiles),
    fileTree: parseFileTreeState(record.fileTree),
    ...(parsePaneLayout(record) ?? emptyReaderSession),
  };
}

/** 工作线程注入的阅读器会话存储；写入失败必须抛出，供切库事务恢复原状态。 */
export type ReaderSessionStore = {
  load: () => ReaderSession;
  save: (session: ReaderSession) => void;
};
