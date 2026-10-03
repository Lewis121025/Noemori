import { isEntryPath } from "./file-browser";

/** 导出的资源预算；原生文件层再次核验源文件数量和字节总量。 */
export const EXPORT_LIMITS = {
  files: 10_000,
  bytes: 5 * 1024 ** 3,
  memoryBytes: 2 * 1024 ** 3,
  resourceBytes: 64 * 1024 ** 2,
  imagePixels: 32 * 1024 ** 2,
  imageEdge: 16_384,
  downloadMs: 30_000,
  downloadConcurrency: 4,
  redirects: 5,
  renderMs: 180_000,
  embedDepth: 3,
} as const;

/** 格式只决定输出，所有入口共用保存、预检与提交事务。 */
export const EXPORT_FORMATS = ["pdf", "docx", "markdown", "archive", "png", "svg"] as const;
/** 可执行的导出格式。 */
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** 全库与显式选择互斥；路径始终属于请求指定的笔记库。 */
export type ExportRequest = {
  root: string;
  format: ExportFormat;
  scope: { kind: "vault" } | { kind: "selection"; paths: string[] };
};
/** 诊断保留来源位置，用户可返回原文修复；警告不会伪装为必要内容成功。 */
export type ExportIssue = {
  path: string;
  message: string;
  severity: "error" | "warning";
  line?: number;
};
/** 状态表示实际完成的工作；未知总量为 null。 */
export type ExportProgress = {
  phase:
    | "saving"
    | "checking"
    | "snapshotting"
    | "converting"
    | "validating"
    | "packaging"
    | "committing";
  completed: number;
  total: number | null;
  path: string | null;
};
/** 预检结果仅提供用户可审阅的清单，不泄露内部暂存目录。 */
export type ExportPlan = { files: string[]; bytes: number; issues: ExportIssue[] };
/** 校验预检通知，不允许负计数或格式错误的诊断掩盖内容缺失。 */
export function parseExportPlan(value: unknown): ExportPlan {
  if (
    typeof value !== "object" ||
    value === null ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    value.files.length > EXPORT_LIMITS.files ||
    !value.files.every(
      (path: unknown): path is string =>
        typeof path === "string" && path !== "" && !path.includes("\0"),
    ) ||
    new Set(value.files).size !== value.files.length ||
    !("bytes" in value) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > EXPORT_LIMITS.bytes ||
    !("issues" in value)
  )
    throw new Error("导出预检响应无效");
  return { files: value.files, bytes: value.bytes, issues: parseExportIssues(value.issues) };
}
/** 提交后的异常仍是成功警告；失败结果不携带假定生成的路径。 */
export type ExportResult =
  | { status: "saved"; path: string; issues: ExportIssue[]; warning: string | null }
  | { status: "cancelled" }
  | { status: "failed"; issues: ExportIssue[] };

/** 校验窗口输入；非法格式、根目录或选择整体拒绝，不删除部分输入后继续。 */
export function parseExportRequest(value: unknown): ExportRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("root" in value) ||
    typeof value.root !== "string" ||
    value.root === "" ||
    value.root.includes("\0") ||
    !("format" in value) ||
    !("scope" in value)
  )
    throw new Error("导出请求无效");
  const format = EXPORT_FORMATS.find((item) => item === value.format);
  const scope = value.scope;
  if (format === undefined || typeof scope !== "object" || scope === null || !("kind" in scope))
    throw new Error("导出格式或范围无效");
  if (scope.kind === "vault") {
    if ("paths" in scope) throw new Error("整库范围不能同时指定文件选择");
    return { root: value.root, format, scope: { kind: "vault" } };
  }
  if (
    scope.kind !== "selection" ||
    !("paths" in scope) ||
    !Array.isArray(scope.paths) ||
    scope.paths.length === 0 ||
    !scope.paths.every(isEntryPath)
  )
    throw new Error("请选择有效的导出文件或文件夹");
  return {
    root: value.root,
    format,
    scope: { kind: "selection", paths: [...new Set(scope.paths)] },
  };
}

/** 校验跨进程任务编号，避免过期窗口取消另一项任务。 */
export function parseExportId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value))
    throw new Error("导出任务编号无效");
  return value;
}

/** 校验诊断内容；未知状态不能作为成功呈现。 */
export function parseExportIssues(value: unknown): ExportIssue[] {
  if (!Array.isArray(value)) throw new Error("导出诊断无效");
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("path" in item) ||
      typeof item.path !== "string" ||
      !("message" in item) ||
      typeof item.message !== "string" ||
      item.message === "" ||
      !("severity" in item) ||
      (item.severity !== "warning" && item.severity !== "error")
    )
      throw new Error("导出诊断无效");
    const issue: ExportIssue = { path: item.path, message: item.message, severity: item.severity };
    if ("line" in item) {
      if (typeof item.line !== "number" || !Number.isSafeInteger(item.line) || item.line < 1)
        throw new Error("导出诊断位置无效");
      issue.line = item.line;
    }
    return issue;
  });
}

/** 校验最终结果；只有存在明确提交位置的 saved 才表示成功。 */
export function parseExportResult(value: unknown): ExportResult {
  if (typeof value !== "object" || value === null || !("status" in value))
    throw new Error("导出结果无效");
  if (value.status === "cancelled") return { status: "cancelled" };
  if (!("issues" in value)) throw new Error("导出结果缺少诊断");
  const issues = parseExportIssues(value.issues);
  if (value.status === "failed" && issues.some((issue) => issue.severity === "error"))
    return { status: "failed", issues };
  if (
    value.status === "saved" &&
    "path" in value &&
    typeof value.path === "string" &&
    value.path !== "" &&
    "warning" in value &&
    (value.warning === null || typeof value.warning === "string") &&
    issues.every((issue) => issue.severity === "warning")
  )
    return { status: "saved", path: value.path, issues, warning: value.warning };
  throw new Error("导出结果状态矛盾");
}

/** 校验进度，不允许负数、超出总数或未知阶段进入界面。 */
export function parseExportProgress(value: unknown): ExportProgress {
  const phases: readonly ExportProgress["phase"][] = [
    "saving",
    "checking",
    "snapshotting",
    "converting",
    "validating",
    "packaging",
    "committing",
  ];
  if (
    typeof value !== "object" ||
    value === null ||
    !("phase" in value) ||
    !("completed" in value) ||
    typeof value.completed !== "number" ||
    !Number.isSafeInteger(value.completed) ||
    value.completed < 0 ||
    !("total" in value) ||
    (value.total !== null &&
      (typeof value.total !== "number" ||
        !Number.isSafeInteger(value.total) ||
        value.total < value.completed)) ||
    !("path" in value) ||
    (value.path !== null && typeof value.path !== "string")
  )
    throw new Error("导出进度无效");
  const phase = phases.find((item) => item === value.phase);
  if (phase === undefined) throw new Error("导出阶段无效");
  return { phase, completed: value.completed, total: value.total, path: value.path };
}
