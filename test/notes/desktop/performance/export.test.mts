import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { unzipSync } from "fflate";
import { launchExportApp, thousandPageExportSource } from "../support/export-app";

const exec = promisify(execFile);

test("EXP-PERF-1000 离线生产构建完整转换千页正文，内存不超过 2 GiB", async (t) => {
  const { paragraphs, source } = thousandPageExportSource();
  const fixture = await launchExportApp(t, { "large.md": source });
  const { app, page, destination, request } = fixture;
  let peakKiB = 0;
  let peakProcesses: number[][] = [];
  let peakProcessNames: string[] = [];
  let polling = false;
  let sampleError: unknown;
  const pid = app.process().pid;
  if (pid === undefined) throw new Error("缺少宿主进程编号");
  const sample = async () => {
    if (polling) return;
    polling = true;
    try {
      const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="]);
      const lines = stdout.trim().split("\n");
      const rows = lines.map((line) => line.trim().split(/\s+/).slice(0, 3).map(Number));
      const selected = new Set([pid]);
      for (let pass = 0; pass < rows.length; pass++) {
        const before = selected.size;
        for (const [child, parent] of rows)
          if (child !== undefined && parent !== undefined && selected.has(parent))
            selected.add(child);
        if (selected.size === before) break;
      }
      const rss = rows.reduce(
        (sum, [child, , memory]) =>
          sum + (child !== undefined && selected.has(child) ? (memory ?? 0) : 0),
        0,
      );
      if (rss > peakKiB) {
        peakKiB = rss;
        peakProcesses = rows.filter(([child]) => child !== undefined && selected.has(child));
        peakProcessNames = lines.filter((line) =>
          selected.has(Number(line.trim().split(/\s+/, 1)[0])),
        );
      }
    } catch (error) {
      sampleError = error;
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void sample(), 250);
  t.onTestFinished(() => clearInterval(timer));
  const timings: Record<string, number> = {};
  for (const format of ["pdf", "docx"] as const) {
    const target = await destination(`large.${format}`);
    const start = performance.now();
    const result = await page.evaluate(
      (value) => window.noemori.reader.exportRun(value),
      request(format, ["large.md"]),
    );
    const elapsed = performance.now() - start;
    timings[format] = elapsed;
    expect(result).toMatchObject({ status: "saved", warning: null, issues: [] });
    expect(elapsed, `${format} 全链路超出 180 秒`).toBeLessThanOrEqual(180000);
    if (format === "pdf") {
      const { stdout: info } = await exec("/opt/homebrew/bin/pdfinfo", [target]);
      const count = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
      expect(count).toBeGreaterThanOrEqual(1000);
      const { stdout: text } = await exec("/opt/homebrew/bin/pdftotext", ["-layout", target, "-"], {
        maxBuffer: 16 * 1024 ** 2,
      });
      const markers = [...text.matchAll(/P\d{5}/g)].map((match) => match[0]);
      expect(markers).toEqual(paragraphs.map((paragraph) => paragraph.slice(0, 6)));
      console.info("千页 PDF", JSON.stringify({ pages: count, milliseconds: elapsed }));
    } else {
      const parts = unzipSync(await readFile(target));
      const xml = new TextDecoder().decode(parts["word/document.xml"]);
      const markers = [...xml.matchAll(/P\d{5}/g)].map((match) => match[0]);
      expect(markers).toEqual(paragraphs.map((paragraph) => paragraph.slice(0, 6)));
    }
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  }
  clearInterval(timer);
  await sample();
  expect(sampleError).toBeUndefined();
  console.info(
    "导出压力采样",
    JSON.stringify({
      timings,
      peakKiB,
      peakProcesses,
      peakProcessNames,
      mainPid: pid,
      paragraphs: paragraphs.length,
    }),
  );
  expect(peakKiB).toBeGreaterThan(0);
  expect(peakKiB, "导出进程总 RSS 超出 2 GiB").toBeLessThanOrEqual(2 * 1024 ** 2);
  expect(fixture.errors).toEqual([]);
  console.info("导出压力验收", JSON.stringify({ timings, peakKiB, paragraphs: paragraphs.length }));
}, 420000);
