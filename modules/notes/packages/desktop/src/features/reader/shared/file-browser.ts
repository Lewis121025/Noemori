import type { VaultEntry } from "./api";

/** 以首个可见条目和行内偏移恢复位置，前方新增文件不会把视口推到别处。 */
export type FileTreePosition = { path: string; offset: number };

/** 文件管理偏好随库保存；保留旧布局字段的读取，默认呈现层级列表与文章预览。 */
export type FilePresentation = {
  layout: "list" | "grid";
  sort: "name" | "name-desc" | "type" | "modified";
  preview: boolean;
};

/** 资料管理的浏览入口；只保存查询文本，结果恢复时从当前索引重新读取。 */
type LibraryBrowse = {
  query: string;
  section: "files" | "tags" | "bookmarks";
  directory?: string;
};

/** 目录的持久化工作现场；旧会话缺少 browse 时显示全部资料。 */
export type FileTreeState = {
  /** 对话节点的展开与统一视口位置独立保存，不能流入文件路径操作。 */
  discussions?: DiscussionTreeState;
  presentation?: FilePresentation;
  browse?: LibraryBrowse;
  expanded: string[];
  selected: string[];
  focused: string | null;
  scroll: FileTreePosition | null;
  /** 左侧导航与资料管理可同时显示，滚动锚点必须按视口独立。 */
  navigationScroll?: FileTreePosition | null;
};

/** 合成节点可以包含非路径身份；文件选择仍只允许真实库内路径。 */
export type DiscussionTreeState = {
  expanded: string[];
  archived: boolean;
  scroll: { key: string; offset: number } | null;
};
function treeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 16384 &&
    (isEntryPath(value) || /^\0(?:conversation|source|workspace):[^\0]+$/u.test(value))
  );
}
function parseDiscussions(value: unknown): DiscussionTreeState | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("expanded" in value) ||
    !Array.isArray(value.expanded) ||
    !value.expanded.every(treeKey) ||
    !("archived" in value) ||
    typeof value.archived !== "boolean" ||
    !("scroll" in value)
  )
    return null;
  const scroll = value.scroll;
  if (scroll === null)
    return { expanded: [...new Set(value.expanded)], archived: value.archived, scroll: null };
  if (
    typeof scroll !== "object" ||
    !("key" in scroll) ||
    !treeKey(scroll.key) ||
    !("offset" in scroll) ||
    typeof scroll.offset !== "number" ||
    !Number.isFinite(scroll.offset)
  )
    return null;
  return {
    expanded: [...new Set(value.expanded)],
    archived: value.archived,
    scroll: { key: scroll.key, offset: Math.max(0, Math.min(500, scroll.offset)) },
  };
}

/** 返回互不共享数组的空目录状态，不触发磁盘读写。 */
export function emptyFileTreeState(): FileTreeState {
  return { expanded: [], selected: [], focused: null, scroll: null };
}

/** 协议以 / 分隔路径；Unix 文件名中的反斜杠须原样保留，磁盘越界由内核按平台校验。 */
export function isEntryPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("\0") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

/** 损坏的浏览现场回退到全部资料；IPC 调用方另行拒绝非法输入。 */
function parseBrowse(value: unknown): LibraryBrowse | null {
  if (typeof value !== "object" || value === null || !("query" in value) || !("section" in value))
    return null;
  if (
    typeof value.query !== "string" ||
    (value.section !== "files" && value.section !== "tags" && value.section !== "bookmarks")
  )
    return null;
  return {
    query: value.query,
    section: value.section,
    ...("directory" in value && (value.directory === "" || isEntryPath(value.directory))
      ? { directory: value.directory }
      : {}),
  };
}

function parsePresentation(value: unknown): FilePresentation | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("layout" in value) ||
    !("sort" in value) ||
    !("preview" in value) ||
    (value.layout !== "list" && value.layout !== "grid") ||
    (value.sort !== "name" &&
      value.sort !== "name-desc" &&
      value.sort !== "type" &&
      value.sort !== "modified") ||
    typeof value.preview !== "boolean"
  )
    return null;
  return { layout: value.layout, sort: value.sort, preview: value.preview };
}

/** 恢复单个文件视口；非法字段回退为无锚点。 */
function parseTreePosition(value: unknown): FileTreePosition | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("path" in value) ||
    !("offset" in value) ||
    !isEntryPath(value.path) ||
    typeof value.offset !== "number" ||
    !Number.isFinite(value.offset)
  )
    return null;
  return { path: value.path, offset: Math.max(0, Math.min(value.offset, 500)) };
}

/** 损坏的会话字段逐项丢弃；缺失状态返回 null，供首次打开时定位当前文档。 */
export function parseFileTreeState(value: unknown): FileTreeState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const paths = (input: unknown): string[] =>
    Array.isArray(input) ? [...new Set(input.filter(isEntryPath))] : [];
  const browse = parseBrowse(record.browse);
  const presentation = parsePresentation(record.presentation);
  const discussions = parseDiscussions(record.discussions);
  return {
    ...(presentation === null ? {} : { presentation }),
    ...(discussions === null ? {} : { discussions }),
    ...(browse === null ? {} : { browse }),
    expanded: paths(record.expanded),
    selected: paths(record.selected),
    focused: isEntryPath(record.focused) ? record.focused : null,
    scroll: parseTreePosition(record.scroll),
    ...(record.navigationScroll === undefined
      ? {}
      : { navigationScroll: parseTreePosition(record.navigationScroll) }),
  };
}

/** IPC 必须携带完整目录状态；拒绝缺字段的空对象，避免意外清空用户现场。 */
export function parseFileTreeMessage(value: unknown): FileTreeState {
  if (typeof value !== "object" || value === null) throw new Error("目录会话无效");
  const item = value as Record<string, unknown>;
  const state = parseFileTreeState(value);
  if (
    state === null ||
    (item.discussions !== undefined && parseDiscussions(item.discussions) === null) ||
    (item.presentation !== undefined && parsePresentation(item.presentation) === null) ||
    !Array.isArray(item.expanded) ||
    !item.expanded.every(isEntryPath) ||
    !Array.isArray(item.selected) ||
    !item.selected.every(isEntryPath) ||
    (item.focused !== null && !isEntryPath(item.focused)) ||
    (item.scroll !== null && state.scroll === null) ||
    (item.navigationScroll !== undefined &&
      item.navigationScroll !== null &&
      state.navigationScroll === null) ||
    (item.browse !== undefined &&
      (parseBrowse(item.browse) === null ||
        (typeof item.browse === "object" &&
          item.browse !== null &&
          "directory" in item.browse &&
          item.browse.directory !== "" &&
          !isEntryPath(item.browse.directory))))
  )
    throw new Error("目录会话无效");
  return state;
}

/** 改名、删除与外部清单刷新共用路径迁移；不修改输入，失效路径返回 null 后移除。 */
export function mapFileTreeState(
  state: FileTreeState,
  map: (path: string) => string | null,
): FileTreeState {
  const paths = (items: string[]) => [
    ...new Set(
      items.flatMap((path) => {
        const next = map(path);
        return next === null ? [] : [next];
      }),
    ),
  ];
  const mapPosition = (position: FileTreePosition | null): FileTreePosition | null => {
    if (position === null) return null;
    const path = map(position.path);
    return path === null ? null : { path, offset: position.offset };
  };
  const mapKey = (key: string) => (key.startsWith("\0") ? key : map(key));
  const discussions = state.discussions;
  const scrollKey = discussions?.scroll ? mapKey(discussions.scroll.key) : null;
  return {
    ...(discussions
      ? {
          discussions: {
            ...discussions,
            expanded: discussions.expanded.flatMap((key) => {
              const next = mapKey(key);
              return next === null ? [] : [next];
            }),
            scroll:
              scrollKey !== null && discussions.scroll
                ? { key: scrollKey, offset: discussions.scroll.offset }
                : null,
          },
        }
      : {}),
    ...(state.presentation === undefined ? {} : { presentation: { ...state.presentation } }),
    ...(state.browse === undefined
      ? {}
      : {
          browse: {
            ...state.browse,
            ...(state.browse.directory === undefined
              ? {}
              : {
                  directory:
                    state.browse.directory === "" ? "" : (map(state.browse.directory) ?? ""),
                }),
          },
        }),
    expanded: paths(state.expanded),
    selected: paths(state.selected),
    focused: state.focused === null ? null : map(state.focused),
    scroll: mapPosition(state.scroll),
    ...(state.navigationScroll === undefined
      ? {}
      : { navigationScroll: mapPosition(state.navigationScroll) }),
  };
}

/** 按最新目录去掉失效状态；草稿的虚拟父目录保留展开能力，但恢复专区不参与选择。 */
export function reconcileFileTreeState(
  state: FileTreeState,
  entries: readonly VaultEntry[],
): FileTreeState {
  const paths = new Set<string>();
  const directories = new Set<string>();
  for (const entry of entries) {
    if (entry.recoveryOnly) continue;
    paths.add(entry.path);
    if (entry.kind === "directory") directories.add(entry.path);
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      paths.add(parent);
      directories.add(parent);
    }
  }
  const next = mapFileTreeState(state, (path) => (paths.has(path) ? path : null));
  if (next.browse?.directory && !directories.has(next.browse.directory)) next.browse.directory = "";
  next.expanded = next.expanded.filter((path) => directories.has(path));
  return next;
}
