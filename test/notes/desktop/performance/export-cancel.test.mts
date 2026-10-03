import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchExportApp, thousandPageExportSource } from "../support/export-app";
import { checkBudget } from "./budget";

test("EXP-CANCEL 千页任务进入冻结或转换后仍能在预算内停止，不能只测试启动前取消", async (t) => {
  const { source } = thousandPageExportSource();
  const { page, request, state } = await launchExportApp(t, { "large.md": source });
  const timings: number[] = [];
  for (let index = 0; index < 35; index++) {
    const observation = await page.evaluate(
      async (value) => {
        let start: number | null = null;
        let acceptance: Promise<boolean> | null = null;
        let phase: string | null = null;
        const result = await window.noemori.reader.exportRun(value, (progress) => {
          if (acceptance !== null || !["snapshotting", "converting"].includes(progress.phase))
            return;
          phase = progress.phase;
          start = performance.now();
          acceptance = window.noemori.reader.exportCancel();
        });
        return {
          result,
          accepted: await acceptance,
          phase,
          elapsed: start === null ? null : performance.now() - start,
        };
      },
      request("pdf", ["large.md"]),
    );
    expect(observation.result.status).toBe("cancelled");
    expect(observation.accepted).toBe(true);
    expect(observation.elapsed).not.toBeNull();
    if (index >= 5 && observation.elapsed !== null) timings.push(observation.elapsed);
    expect(
      (await readdir(join(state, "export-jobs"))).filter((name) => name.startsWith("job-")),
    ).toEqual([]);
  }
  await checkBudget("export-large-cancel", timings, 1000);
}, 300000);

test("EXP-CANCEL-CONTENT 复杂公式转换已经运行时，取消仍必须在一秒内响应", async (t) => {
  const source = Array.from(
    { length: 50_000 },
    (_, index) => `段落 ${index} $\\frac{x_{${index}}^2+\\sqrt{y}}{1+z}$。`,
  ).join("\n\n");
  const { page, request } = await launchExportApp(t, { "formulas.md": source });
  const timings: number[] = [];
  for (let trial = 0; trial < 35; trial++) {
    const observation = await page.evaluate(
      async (value) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let started: number | undefined;
        let accepted: Promise<boolean> | undefined;
        try {
          const result = await window.noemori.reader.exportRun(value, (progress) => {
            if (progress.phase !== "converting" || timer !== undefined) return;
            timer = setTimeout(() => {
              started = performance.now();
              accepted = window.noemori.reader.exportCancel();
            }, 200);
          });
          return {
            result,
            accepted: await accepted,
            elapsed: started === undefined ? null : performance.now() - started,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      request("pdf", ["formulas.md"]),
    );
    expect(observation.result.status).toBe("cancelled");
    expect(observation.accepted).toBe(true);
    if (trial >= 5 && observation.elapsed !== null) timings.push(observation.elapsed);
  }
  expect(timings).toHaveLength(30);
  await checkBudget("export-content-cancel", timings, 1000);
}, 300000);

test("EXP-CANCEL-MATH 快照封存后正在编译公式时，取消不能被主进程计算阻塞", async (t) => {
  const source = Array.from(
    { length: 15_000 },
    (_, index) => `段落 ${index} $\\frac{x_{${index}}^2+\\sqrt{y}}{1+z}$。`,
  ).join("\n\n");
  const { page, request } = await launchExportApp(t, { "math.md": source });
  const timings: number[] = [];
  for (let trial = 0; trial < 35; trial++) {
    const observation = await page.evaluate(
      async (value) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let started: number | undefined;
        let accepted: Promise<boolean> | undefined;
        try {
          const result = await window.noemori.reader.exportRun(value, undefined, () => {
            timer = setTimeout(() => {
              started = performance.now();
              accepted = window.noemori.reader.exportCancel();
            }, 200);
          });
          return {
            result,
            accepted: await accepted,
            elapsed: started === undefined ? null : performance.now() - started,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      request("docx", ["math.md"]),
    );
    expect(observation.result.status).toBe("cancelled");
    expect(observation.accepted).toBe(true);
    expect(observation.elapsed).not.toBeNull();
    expect(observation.elapsed).toBeLessThan(1000);
    if (trial >= 5 && observation.elapsed !== null) timings.push(observation.elapsed);
  }
  expect(timings).toHaveLength(30);
  await checkBudget("export-math-cancel", timings, 1000);
}, 600000);
