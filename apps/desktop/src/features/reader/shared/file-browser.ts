import type { VaultEntry } from "./api";

/** 以首个可见条目和行内偏移恢复位置，前方新增文件不会把视口推到别处。 */
export type FileTreePosition = { path: string; offset: number };

/** 目录的持久化工作现场；查询与临时结果不写入会话。 */
export type FileTreeState = {
  expanded: string[];
  selected: string[];
  focused: string | null;
  scroll: FileTreePosition | null;
};

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

/** 损坏的会话字段逐项丢弃；缺失状态返回 null，供首次打开时定位当前文档。 */
export function parseFileTreeState(value: unknown): FileTreeState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const paths = (input: unknown): string[] =>
    Array.isArray(input) ? [...new Set(input.filter(isEntryPath))] : [];
  const scroll = record.scroll;
  return {
    expanded: paths(record.expanded),
    selected: paths(record.selected),
    focused: isEntryPath(record.focused) ? record.focused : null,
    scroll:
      typeof scroll === "object" &&
      scroll !== null &&
      "path" in scroll &&
      "offset" in scroll &&
      isEntryPath(scroll.path) &&
      typeof scroll.offset === "number" &&
      Number.isFinite(scroll.offset)
        ? { path: scroll.path, offset: Math.max(0, Math.min(scroll.offset, 500)) }
        : null,
  };
}

/** IPC 必须携带完整目录状态；拒绝缺字段的空对象，避免意外清空用户现场。 */
export function parseFileTreeMessage(value: unknown): FileTreeState {
  if (typeof value !== "object" || value === null) throw new Error("目录会话无效");
  const item = value as Record<string, unknown>;
  const state = parseFileTreeState(value);
  if (
    state === null ||
    !Array.isArray(item.expanded) ||
    !item.expanded.every(isEntryPath) ||
    !Array.isArray(item.selected) ||
    !item.selected.every(isEntryPath) ||
    (item.focused !== null && !isEntryPath(item.focused)) ||
    (item.scroll !== null && state.scroll === null)
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
  const scrollPath = state.scroll === null ? null : map(state.scroll.path);
  return {
    expanded: paths(state.expanded),
    selected: paths(state.selected),
    focused: state.focused === null ? null : map(state.focused),
    scroll: scrollPath === null ? null : { path: scrollPath, offset: state.scroll?.offset ?? 0 },
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
  next.expanded = next.expanded.filter((path) => directories.has(path));
  return next;
}
