/// <reference path="../../../../modules/notes/packages/desktop/src/renderer/env.d.ts" />
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { test } from "vitest";
import { CoreClient } from "../../../../modules/notes/packages/desktop/src/main/core-client";
import { readFileContent } from "../../../../modules/notes/packages/desktop/src/features/reader/renderer/document/file-content";

const workerUrl = new URL("../../../../modules/notes/packages/desktop/out/main/core-worker.js", import.meta.url);

async function measure(name: string, run: () => unknown) {
  for (let index = 0; index < 5; index += 1) await run();
  const samples: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const middle = samples.length / 2;
  console.table([
    {
      场景: name,
      样本数: samples.length,
      平均毫秒: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      中位毫秒: (samples[middle - 1]! + samples[middle]!) / 2,
      P95毫秒: samples[Math.ceil(samples.length * 0.95) - 1],
    },
  ]);
}

test("文本打开时的解码与类型检查", async () => {
  const encoder = new TextEncoder();
  const inputs = [
    ["ASCII 文本", "A line of plain text.\n".repeat(200_000)],
    ["中英混合文本", "中文正文与符号 αβ 🌱\n".repeat(120_000)],
  ] as const;
  for (const [name, source] of inputs) {
    const bytes = encoder.encode(source);
    assert.equal(readFileContent("large.txt", bytes).kind, "text");
    await measure(`${(bytes.length / 1024 ** 2).toFixed(1)} MiB ${name}`, () =>
      readFileContent("large.txt", bytes),
    );
  }
});

test("实际内核线程读取附件", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-reading-bench-"));
  let core: CoreClient | undefined;
  t.onTestFinished(async () => {
    try {
      await core?.shutdown();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const vault = join(directory, "vault");
  await mkdir(vault);
  await writeFile(join(vault, "attachment.bin"), new Uint8Array(16 * 1024 * 1024).fill(173));
  const client = new CoreClient(
    new Worker(workerUrl, {
      workerData: join(directory, "state"),
    }),
    () => {},
  );
  core = client;
  await client.call("vaultOpen", vault);
  await measure("16 MiB 附件读取并返回主进程", async () => {
    const bytes = await client.call("fileRead", "attachment.bin");
    assert.equal(bytes.length, 16 * 1024 * 1024);
    assert.equal(bytes[bytes.length - 1], 173);
  });
});
