import { computeExport } from "@reader/main/export/computation";
import { mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { exportDocx } from "@reader/main/export/pandoc";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import type { PreparedExportDocument } from "@reader/main/export/documents";
import { EXPORT_LIMITS } from "@reader/shared/export";

const note: PreparedExportDocument = {
  path: "a.md",
  output: "documents/a.docx",
  doc: parseMarkdown("# 转换故障\n\n不得发布半成品。"),
  anchors: [],
  locations: new Map(),
  formulaLocations: new Map(),
};
async function executable(t: TestContext, body: string) {
  const directory = await mkdtemp(join(tmpdir(), "noemori-pandoc-fault-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pandoc-fixture.mjs");
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return { directory, path };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("EXP-FAULT Pandoc 进程与输出故障", () => {
  it.for([
    {
      body: 'process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("controlled failure"); process.exitCode = 2; });',
      message: "controlled failure",
    },
    {
      body: 'process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("strict warning"); process.stdout.write("candidate"); });',
      message: "strict warning",
    },
    {
      body: 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("invalid zip"));',
      message: "DOCX 包校验失败",
    },
  ])("非零退出、警告或损坏产物都拒绝：%j", async ({ body, message }, t) => {
    const fixture = await executable(t, body);
    await expect(
      exportDocx(
        note,
        fixture.directory,
        new AbortController().signal,
        computeExport,
        fixture.path,
      ),
    ).rejects.toThrow(message);
  });

  it("缺少随包可执行文件不退回系统 PATH", async (t) => {
    const fixture = await executable(t, "");
    await expect(
      exportDocx(
        note,
        fixture.directory,
        new AbortController().signal,
        computeExport,
        fixture.path + ".missing",
      ),
    ).rejects.toThrow("ENOENT");
  });

  it.for([0, 1100])("子进程启动延迟 %i ms 后取消仍等待退出，不遗留后台转换", async (delay, t) => {
    const fixture = await executable(
      t,
      `import { writeFileSync, renameSync } from "node:fs"; await new Promise(resolve => setTimeout(resolve, ${delay})); writeFileSync("child.starting", String(process.pid)); renameSync("child.starting", "child.pid"); process.stdin.resume(); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    t.onTestFinished(() => controller.abort());
    // 原子发布就绪文件；先订阅再启动，避免固定轮询期限把启动调度误判成取消失败。
    const events = watch(fixture.directory, { signal: controller.signal });
    const started = (async () => {
      for await (const event of events) {
        if (event.filename !== "child.pid") continue;
        return Number(await readFile(join(fixture.directory, "child.pid"), "utf8"));
      }
      throw new Error("测试子进程未报告就绪");
    })();
    const running = exportDocx(
      note,
      fixture.directory,
      controller.signal,
      computeExport,
      fixture.path,
    );
    const rejected = expect(running).rejects.toThrow("导出已取消");
    let pid: number;
    try {
      pid = await Promise.race([
        started,
        running.then(() => {
          throw new Error("测试子进程在取消前意外完成");
        }),
      ]);
      expect(pid).toBeGreaterThan(0);
    } finally {
      controller.abort();
      await events.return?.();
      await rejected;
    }
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("达到 180 秒时终止进程且撤销超时计时器", async (t) => {
    const fixture = await executable(t, "process.stdin.resume(); setInterval(() => {}, 1000);");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = exportDocx(
      note,
      fixture.directory,
      new AbortController().signal,
      computeExport,
      fixture.path,
    );
    const rejected = expect(running).rejects.toThrow("180 秒");
    await vi.advanceTimersByTimeAsync(EXPORT_LIMITS.renderMs);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
