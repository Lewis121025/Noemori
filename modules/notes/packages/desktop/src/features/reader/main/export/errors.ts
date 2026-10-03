import type { ExportIssue } from "../../shared/export";

/** 内容失败携带来源字段，协调器不从本地化文字中反向猜测路径或行号。 */
export class ExportFailure extends Error {
  /** @param issues 本次失败的完整诊断；已有结构化原因不会在跨阶段时丢失。 */
  constructor(readonly issues: ExportIssue[]) {
    super(
      issues
        .map((issue) => `${issue.path}${issue.line ? `:${issue.line}` : ""}：${issue.message}`)
        .join("\n"),
    );
  }
}

/** 保留底层错误内容，未知抛出值也不能被吞掉。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
