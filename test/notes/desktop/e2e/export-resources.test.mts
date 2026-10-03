import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchExportApp } from "../support/export-app";
import { checkBudget } from "../performance/budget";

const cycles = Number(process.env["NOEMORI_EXPORT_CYCLES"] ?? "240");
if (!Number.isSafeInteger(cycles) || cycles < 240 || cycles > 10000)
  throw new Error("导出循环数必须为 240–10000 的整数");

test(
  "EXP-SOAK 真实 IPC 混合成功、失败、取消循环释放进程、窗口、订阅和暂存",
  async (t) => {
    const fixture = await launchExportApp(t, {
      "small.md": "# 导出持久运行\n\n中文可搜索文字。$\\frac{x}{2}$\n\n![[image.svg]]\n",
      "bad.md": "$\\NoemoriUnknown{x}$\n",
      "image.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="blue"/></svg>',
      "board.noemoriboard": JSON.stringify({
        version: 1,
        strokes: [
          {
            id: "a",
            width: 4,
            points: [
              { x: -50, y: -20, pressure: 1 },
              { x: 90, y: 50, pressure: 1 },
            ],
          },
        ],
      }),
    });
    const { app, page, destination, request, state } = fixture;
    const cdp = await page.context().newCDPSession(page);
    const feedback: number[] = [];
    const responses: number[] = [];
    const cancellation: number[] = [];
    const sample = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      return {
        dom: await cdp.send("Memory.getDOMCounters"),
        heap: await cdp.send("Runtime.getHeapUsage"),
        main: await app.evaluate(({ app, BrowserWindow, webContents, ipcMain }) => {
          global.gc?.();
          const contents = webContents.getAllWebContents();
          return {
            windows: BrowserWindow.getAllWindows().length,
            contents: contents.length,
            heap: process.memoryUsage().heapUsed,
            resources: process.getActiveResourcesInfo().sort(),
            listeners: contents.reduce(
              (sum, item) =>
                sum +
                item.eventNames().reduce((total, event) => total + item.listenerCount(event), 0),
              0,
            ),
            ipcListeners: ipcMain
              .eventNames()
              .reduce((sum, name) => sum + ipcMain.listenerCount(name), 0),
            processes: app
              .getAppMetrics()
              .map((item) => ({ type: item.type, rss: item.memory.workingSetSize })),
          };
        }),
      };
    };
    const cycle = async (index: number, measuring: boolean) => {
      const kind = index % 8;
      const format = (
        ["pdf", "docx", "markdown", "archive", "png", "svg", "docx", "archive"] as const
      )[kind];
      if (!format) throw new Error("循环格式丢失");
      const path =
        kind === 6 ? "bad.md" : kind === 4 || kind === 5 ? "board.noemoriboard" : "small.md";
      const target = await destination(`cycle-${index}.${format}`);
      if (kind >= 6) await writeFile(target, "existing target remains unchanged");
      const observation = await page.evaluate(
        async ({ value, cancel }) => {
          const api = window.noemori.reader;
          const start = performance.now();
          let firstProgress: number | null = null;
          const running = api.exportRun(value, () => {
            firstProgress ??= performance.now() - start;
          });
          const pingStart = performance.now();
          const ping = api.fileRead("Home.md").then(() => performance.now() - pingStart);
          let cancelled = false;
          const cancelStart = performance.now();
          if (cancel) cancelled = await api.exportCancel();
          const result = await running;
          return {
            result,
            cancelled,
            cancelMs: performance.now() - cancelStart,
            firstProgress,
            responseMs: await ping,
          };
        },
        { value: request(format, [path]), cancel: kind === 7 },
      );
      if (kind >= 6) {
        expect(observation.result.status).toBe(kind === 7 ? "cancelled" : "failed");
        if (kind === 7) {
          expect(observation.cancelled).toBe(true);
          if (measuring) cancellation.push(observation.cancelMs);
        }
        expect(await readFile(target, "utf8")).toBe("existing target remains unchanged");
      } else {
        expect(observation.result).toMatchObject({ status: "saved", warning: null, issues: [] });
        expect((await readFile(target)).byteLength).toBeGreaterThan(0);
      }
      if (measuring) {
        expect(observation.firstProgress).not.toBeNull();
        if (observation.firstProgress !== null) feedback.push(observation.firstProgress);
        responses.push(observation.responseMs);
      }
      await rm(target);
      expect(
        (await readdir(join(state, "export-jobs"))).filter((name) => name.startsWith("job-")),
      ).toEqual([]);
      expect(
        await app.evaluate(({ BrowserWindow, webContents }) => ({
          windows: BrowserWindow.getAllWindows().length,
          contents: webContents.getAllWebContents().length,
        })),
      ).toEqual({ windows: 1, contents: 1 });
    };
    for (let index = 0; index < 40; index++) await cycle(index, false);
    const baseline = await sample();
    const verify = (current: Awaited<ReturnType<typeof sample>>) => {
      expect(current.main.windows).toBe(1);
      expect(current.main.contents).toBe(1);
      expect(current.main.listeners).toBe(baseline.main.listeners);
      expect(current.main.ipcListeners).toBe(baseline.main.ipcListeners);
      expect(current.dom.documents).toBeLessThanOrEqual(baseline.dom.documents);
      expect(current.dom.jsEventListeners).toBeLessThanOrEqual(baseline.dom.jsEventListeners);
      expect(current.dom.nodes - baseline.dom.nodes).toBeLessThan(100);
      expect(current.heap.usedSize - baseline.heap.usedSize).toBeLessThan(8 * 1024 ** 2);
      expect(current.main.heap - baseline.main.heap).toBeLessThan(16 * 1024 ** 2);
      expect(current.main.processes.length).toBeLessThanOrEqual(baseline.main.processes.length);
      expect(current.main.processes.reduce((sum, item) => sum + item.rss, 0)).toBeLessThanOrEqual(
        2 * 1024 ** 2,
      );
      for (const resource of new Set(current.main.resources))
        expect(
          current.main.resources.filter((name) => name === resource).length,
          resource,
        ).toBeLessThanOrEqual(baseline.main.resources.filter((name) => name === resource).length);
    };
    for (let index = 0; index < cycles; index++) {
      await cycle(index, true);
      if ((index + 1) % 100 === 0 || index + 1 === cycles) {
        const current = await sample();
        verify(current);
        console.info(
          "导出资源持续观测",
          JSON.stringify({ completed: index + 1, total: cycles, baseline, current }),
        );
      }
    }
    await checkBudget("export-response", responses, 100);
    await checkBudget("export-cancel", cancellation, 1000);
    expect(Math.max(...feedback), "首次状态反馈必须在 200 ms 内").toBeLessThanOrEqual(200);
    expect(fixture.errors).toEqual([]);
    await cdp.detach();
  },
  Math.max(300000, cycles * 2500),
);
