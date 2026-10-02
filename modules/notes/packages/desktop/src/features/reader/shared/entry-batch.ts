import type { VaultEntry } from "./api";
import { isEntryPath } from "./file-browser";

/** 已独立提交的条目变化；to 为 null 表示移入系统废纸篓。 */
export type EntryMutation = { from: string; to: string | null };
/** 批量请求必须携带库归属；目标目录为空字符串表示库根。 */
export type EntryBatchRequest = { root: string; paths: string[] } & (
  { action: "move"; destination: string } | { action: "trash" }
);
/** 预检或执行错误属于具体源条目；空路径表示整批请求受阻。 */
export type EntryBatchIssue = { path: string; message: string };
/** 批量进度只统计已提交条目；执行阶段的总量排除父子重复和已在目标位置的条目。 */
export type EntryBatchProgress = {
  phase: "checking" | "running";
  completed: number;
  total: number;
};

/** IPC 批次编号用于隔离重试、窗口和过期停止请求，无效编号抛错。 */
export function parseEntryBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,80}$/.test(value))
    throw new Error("批量操作编号无效");
  return value;
}

/** 校验进度事件，未知阶段与不可能的计数不能展示为真实完成量。 */
export function parseEntryBatchProgress(value: unknown): EntryBatchProgress {
  if (typeof value !== "object" || value === null) throw new Error("批量操作进度无效");
  const item = value as Record<string, unknown>;
  if (
    (item.phase !== "checking" && item.phase !== "running") ||
    typeof item.completed !== "number" ||
    !Number.isSafeInteger(item.completed) ||
    typeof item.total !== "number" ||
    !Number.isSafeInteger(item.total) ||
    item.completed < 0 ||
    item.completed > item.total ||
    item.total > 10000
  )
    throw new Error("批量操作进度无效");
  return { phase: item.phase, completed: item.completed, total: item.total };
}
/**
 * 部分成功是明确的业务结果；remaining 只包含未提交项，可原样重试。
 * skipped 表示已经在目标位置。提交后的索引/会话警告不得把成功项混入 remaining。
 */
export type EntryBatchResult = {
  completed: EntryMutation[];
  remaining: string[];
  skipped: string[];
  issues: EntryBatchIssue[];
  warning: string | null;
};

/** 父条目覆盖其后代，保留选择次序；同一文件夹及子文件只执行一次。 */
export function independentEntryPaths(paths: readonly string[]): string[] {
  const selected = new Set(paths);
  return [...selected].filter((path) => {
    const parts = path.split("/");
    return !parts
      .slice(0, -1)
      .some((_, index) => selected.has(parts.slice(0, index + 1).join("/")));
  });
}

/** IPC 整体校验，不用部分合法输入替换用户的整批意图；无效请求抛错。 */
export function parseEntryBatchRequest(value: unknown): EntryBatchRequest {
  if (typeof value !== "object" || value === null) throw new Error("批量操作请求无效");
  const item = value as Record<string, unknown>;
  if (
    typeof item.root !== "string" ||
    item.root === "" ||
    item.root.includes("\0") ||
    !Array.isArray(item.paths) ||
    item.paths.length === 0 ||
    item.paths.length > 10000 ||
    !item.paths.every(isEntryPath)
  )
    throw new Error("批量操作包含无效路径");
  const paths = independentEntryPaths(item.paths);
  if (item.action === "trash") return { root: item.root, paths, action: "trash" };
  if (item.action === "move" && (item.destination === "" || isEntryPath(item.destination)))
    return { root: item.root, paths, action: "move", destination: item.destination };
  throw new Error("批量操作目标无效");
}

/**
 * 用同一清单预检整批的名称占用、自身子目录、失效与恢复条目；不触碰磁盘。
 * 此结果用于界面预览；Rust 运行时执行前重新预检，由 Vault 核验真实磁盘与草稿约束。
 */
export function planEntryBatch(
  entries: readonly VaultEntry[],
  request: EntryBatchRequest,
): {
  changes: EntryMutation[];
  skipped: string[];
  issues: EntryBatchIssue[];
} {
  const changes: EntryMutation[] = [];
  const skipped: string[] = [];
  const issues: EntryBatchIssue[] = [];
  const inventory = new Map(entries.map((entry) => [entry.path, entry]));
  const occupied = new Set(inventory.keys());
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++)
      occupied.add(parts.slice(0, index).join("/"));
  }
  if (request.action === "move" && request.destination !== "") {
    const target = inventory.get(request.destination);
    if (target?.kind !== "directory" || target.recoveryOnly)
      issues.push({ path: request.destination, message: "目标文件夹不存在或不可用" });
  }
  const destinations = new Set<string>();
  for (const path of independentEntryPaths(request.paths)) {
    const entry = inventory.get(path);
    if (!entry || entry.recoveryOnly) {
      issues.push({ path, message: "条目已不存在，或需要先处理恢复草稿" });
      continue;
    }
    if (request.action === "trash") {
      changes.push({ from: path, to: null });
      continue;
    }
    const name = path.split("/").at(-1)!;
    const to = request.destination === "" ? name : `${request.destination}/${name}`;
    if (to === path) {
      skipped.push(path);
      continue;
    }
    if (request.destination === path || request.destination.startsWith(`${path}/`))
      issues.push({ path, message: "不能移动到自身或子文件夹" });
    else if (occupied.has(to) || destinations.has(to))
      issues.push({ path, message: `目标已有同名条目：${to}` });
    destinations.add(to);
    changes.push({ from: path, to });
  }
  return { changes, skipped, issues };
}

/** 一次批量结果的同时路径映射；前缀相似的兄弟目录不受影响。 */
export function mapEntryPath(path: string, changes: readonly EntryMutation[]): string | null {
  const change = changes.find(({ from }) => path === from || path.startsWith(`${from}/`));
  return change === undefined
    ? path
    : change.to === null
      ? null
      : change.to + path.slice(change.from.length);
}

/** 桥接响应必须完整且互不矛盾；未知结果抛错，不能把未证实的项报告为成功。 */
export function parseEntryBatchResult(value: unknown): EntryBatchResult {
  const invalid = () => new Error("批量操作响应无效，请刷新目录确认结果");
  if (typeof value !== "object" || value === null) throw invalid();
  const item = value as Record<string, unknown>;
  if (
    !Array.isArray(item.completed) ||
    !Array.isArray(item.remaining) ||
    !item.remaining.every(isEntryPath) ||
    !Array.isArray(item.skipped) ||
    !item.skipped.every(isEntryPath) ||
    !Array.isArray(item.issues) ||
    (item.warning !== null && typeof item.warning !== "string")
  )
    throw invalid();
  const completed = item.completed.map((entry: unknown): EntryMutation => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("from" in entry) ||
      !("to" in entry) ||
      !isEntryPath(entry.from) ||
      (entry.to !== null && !isEntryPath(entry.to))
    )
      throw invalid();
    return { from: entry.from, to: entry.to };
  });
  const issues = item.issues.map((entry: unknown): EntryBatchIssue => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      !("message" in entry) ||
      typeof entry.path !== "string" ||
      typeof entry.message !== "string"
    )
      throw invalid();
    return { path: entry.path, message: entry.message };
  });
  const paths = [...completed.map((change) => change.from), ...item.remaining, ...item.skipped];
  if (new Set(paths).size !== paths.length) throw invalid();
  return {
    completed,
    remaining: item.remaining,
    skipped: item.skipped,
    issues,
    warning: item.warning,
  };
}
