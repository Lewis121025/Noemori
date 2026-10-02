/// <reference path="../../../../modules/notes/packages/desktop/src/renderer/env.d.ts" />
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { expect, test } from "vitest";
import { CoreClient } from "../../../../modules/notes/packages/desktop/src/main/core-client";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

/** 报告全部完成耗时，采样中不删掉排队、转换、fsync 或索引等待。 */
function report(layer: string, count: number, operation: string, samples: number[]): void {
  samples.sort((a, b) => a - b);
  console.info(
    JSON.stringify({
      layer,
      notes: count,
      operation,
      samples: samples.length,
      p50_ms: samples[Math.ceil(samples.length * 0.5) - 1],
      p95_ms: samples[Math.ceil(samples.length * 0.95) - 1],
      p99_ms: samples[Math.ceil(samples.length * 0.99) - 1],
    }),
  );
}

async function samples(run: (index: number) => Promise<unknown>, count = 100): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    await run(index);
    values.push(performance.now() - start);
  }
  return values;
}

for (const count of [1000, 10000]) {
  test(`Rust 宿主与完整 IPC：${count} 篇笔记`, { timeout: 180000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-runtime-bench-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, "vault");
    const userData = join(directory, "state");
    await mkdir(root);
    await mkdir(userData);
    for (let offset = 0; offset < count; offset += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, count - offset) }, (_, item) => {
          const index = offset + item;
          return writeFile(
            join(root, `${index}.md`),
            `# 笔记 ${index}\n\n[[${(index + 1) % count}]]\n\n${"中文与 archive 内容。\n".repeat(40)}`,
          );
        }),
      );
    }
    const core = new CoreClient(userData, () => {});
    const lag = monitorEventLoopDelay({ resolution: 1 });
    try {
      await core.call("vaultOpen", root);
      await core.call("fileRead", "0.md");
      lag.enable();
      report("main-rust", count, "warm_read", await samples(() => core.call("fileRead", "0.md")));
      report(
        "main-rust",
        count,
        "warm_links",
        await samples(() => core.call("indexLinksTo", "0.md")),
      );
      let expected: Uint8Array | null = null;
      report(
        "main-rust",
        count,
        "durable_save",
        await samples(async (index) => {
          const bytes = new TextEncoder().encode(`revision ${index}`);
          const result = await core.call("fileWrite", "saved.md", bytes, expected);
          expect(result).toEqual({ status: "saved", warning: null });
          expected = bytes;
        }),
      );
      lag.disable();
      console.info(
        JSON.stringify({
          layer: "main-rust",
          notes: count,
          event_loop_p95_ms: lag.percentile(95) / 1e6,
          event_loop_p99_ms: lag.percentile(99) / 1e6,
          event_loop_max_ms: lag.max / 1e6,
          memory: process.memoryUsage(),
        }),
      );
      await core.call("readerSessionPatch", {
        documents: {
          panes: [{ currentPath: "0.md", history: { back: [], forward: [] } }],
          active: 0,
          split: false,
        },
      });
    } finally {
      lag.disable();
      await core.shutdown();
    }

    const executable: unknown = require("electron");
    if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (item): item is [string, string] =>
          item[1] !== undefined && item[0] !== "ELECTRON_RENDERER_URL",
      ),
    );
    const app = await electron.launch({
      executablePath: executable,
      env,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${userData}`,
        "--no-sandbox",
      ],
    });
    try {
      const page = await app.firstWindow();
      await page.locator(".ProseMirror").first().waitFor();
      const measured = await page.evaluate(async () => {
        const api = window.noemori.reader;
        const values = {
          warm_read: [] as number[],
          warm_links: [] as number[],
          durable_save: [] as number[],
        };
        await api.fileRead("0.md");
        for (const operation of ["warm_read", "warm_links", "durable_save"] as const) {
          let expected: Uint8Array | null = null;
          for (let index = 0; index < 100; index++) {
            const start = performance.now();
            if (operation === "warm_read") await api.fileRead("0.md");
            else if (operation === "warm_links") await api.indexLinksTo("0.md");
            else {
              const bytes = new TextEncoder().encode(`revision ${index}`);
              const result = await api.fileWrite("ipc-saved.md", bytes, expected);
              if (result.status !== "saved" || result.warning !== null)
                throw new Error("完整保存未成功");
              expected = bytes;
            }
            values[operation].push(performance.now() - start);
          }
        }
        return values;
      });
      for (const [operation, values] of Object.entries(measured))
        report("renderer-ipc-complete", count, operation, values);
    } finally {
      await app.close();
    }
  });
}
