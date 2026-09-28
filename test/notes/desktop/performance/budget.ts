import { arch, cpus, platform, release, totalmem } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

/** 样本必须经过预热，至少 30 个；报告与预算断言使用同一组排序结果。 */
export async function checkBudget(
  name: string,
  values: readonly number[],
  limitMs: number,
): Promise<void> {
  expect(values.length, `${name} 的有效样本不足`).toBeGreaterThanOrEqual(30);
  expect(values.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  const samples = [...values].sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  if (p95 === undefined) throw new Error("缺少性能样本");
  const report = {
    scenario: name,
    samples: values,
    p95,
    budget: limitMs,
    machine: {
      platform: platform(),
      arch: arch(),
      release: release(),
      cpu: cpus()[0]?.model,
      memoryGiB: totalmem() / 1024 ** 3,
    },
  };
  console.info(JSON.stringify(report));
  const directory = process.env["NOUS_PERFORMANCE_REPORT"];
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.json`), JSON.stringify(report, null, 2) + "\n");
  }
  expect(p95, `${name} P95 超出 ${limitMs} ms 预算`).toBeLessThanOrEqual(limitMs);
}
