import { reason } from "./observation.js";

/**
 * 按资源依赖顺序执行全部释放步骤，单个失败不能跳过后续资源，也不能覆盖先前错误。
 * @param releases 按依赖顺序排列的释放入口；后续步骤须允许前一步失败。
 * @returns 全部资源释放成功后完成。
 * @throws AggregateError，包含所有失败的原始异常及可交付给宿主的诊断文本。
 */
export async function releaseBrowserResources(
  releases: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const release of releases) {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `浏览器资源清理失败：${failures.map(reason).join("；")}`);
}
