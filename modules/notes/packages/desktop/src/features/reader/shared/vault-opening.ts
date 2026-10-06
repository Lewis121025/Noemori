/** 开库阶段只描述真实工作，不把阶段序号作为总体百分比。 */
const VAULT_OPEN_PHASES = [
  "preparing",
  "recovering",
  "scanning",
  "checking",
  "reading",
  "indexing",
  "ranking",
  "verifying",
  "committing",
] as const;

/** 同一次开库请求内的阶段进度；总量未知时为 null。 */
export type VaultOpenProgress = {
  phase: (typeof VAULT_OPEN_PHASES)[number];
  completed: number;
  total: number | null;
};

/** 界面与主进程使用同一阶段词汇，避免把可取消准备和最终提交混淆。 */
export const VAULT_OPEN_LABELS: Record<VaultOpenProgress["phase"], string> = {
  preparing: "正在准备打开资料库…",
  recovering: "正在恢复资料库…",
  scanning: "正在扫描文件…",
  checking: "正在核对文件…",
  reading: "正在读取和解析文件…",
  indexing: "正在建立笔记索引…",
  ranking: "正在建立搜索索引…",
  verifying: "正在检查打开期间的文件变化…",
  committing: "正在完成打开…",
};

/** 校验跨进程进度；未知阶段、不可能的数量或溢出均抛错。 */
export function parseVaultOpenProgress(value: unknown): VaultOpenProgress {
  if (
    typeof value !== "object" ||
    value === null ||
    !("phase" in value) ||
    !("completed" in value) ||
    !("total" in value)
  )
    throw new Error("打开进度无效");
  const phase = VAULT_OPEN_PHASES.find((phase) => phase === value.phase);
  const valid = (count: unknown): count is number =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 0x7fffffff;
  if (
    phase === undefined ||
    !valid(value.completed) ||
    (value.total !== null && (!valid(value.total) || value.completed > value.total))
  )
    throw new Error("打开进度的阶段或数量无效");
  return { phase, completed: value.completed, total: value.total };
}

/** 请求编号限定进度和取消归属；无效编号在进入内核前拒绝。 */
export function parseVaultOpenId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,80}$/.test(value))
    throw new Error("打开请求编号无效");
  return value;
}
