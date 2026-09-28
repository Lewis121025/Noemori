import { openLibrary } from "../support/workspace-actions";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

import { knowledgeNote } from "../fixtures/quality-scenes";
import { checkBudget } from "./budget";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("一万文件目录的搜索与键盘响应基准", { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-files-bench-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const folderCount = 100;
  const filesPerFolder = 100;
  for (let folder = 0; folder < folderCount; folder++) {
    const path = join(vault, `目录${folder}`);
    await mkdir(path);
    await Promise.all(
      Array.from({ length: filesPerFolder }, (_, file) =>
        writeFile(join(path, `笔记${file}.md`), knowledgeNote(folder, file)),
      ),
    );
  }
  await writeFile(join(userData, "session.json"), JSON.stringify({ vaultRoot: vault }));
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  const openingAt = performance.now();
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
      "--no-sandbox",
    ],
    env: environment,
  });
  try {
    const page = await app.firstWindow();
    // 首次索引仍沿用原有 120 秒准备预算，交互采样在进入资料管理后开始。
    page.setDefaultTimeout(120_000);
    await openLibrary(page);
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // 在页面内测量输入到下一次绘制，避免把自动化通信与查找断言计入响应耗时。
    const latency = await page.evaluateHandle(() => {
      const samples = {
        search: [] as number[],
        navigation: [] as number[],
        selection: [] as number[],
      };
      function record(target: number[]): void {
        const start = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => target.push(performance.now() - start)),
        );
      }
      document.addEventListener(
        "input",
        (event) => {
          if (
            event.target instanceof HTMLInputElement &&
            event.target.getAttribute("role") === "searchbox" &&
            event.target.value === "笔记"
          )
            record(samples.search);
        },
        true,
      );
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "End") record(samples.navigation);
          if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey))
            record(samples.selection);
        },
        true,
      );
      return samples;
    });
    const files = page.getByRole("navigation", { name: "文件列表" });
    // 首次建立一万篇笔记的索引属于准备阶段，不计入输入到绘制的响应预算。
    await files.getByRole("treeitem", { name: "目录0", exact: true }).waitFor({ timeout: 120000 });
    console.info(
      JSON.stringify({
        scenario: "file-cold-open",
        files: 10000,
        milliseconds: performance.now() - openingAt,
      }),
    );
    const search = files.getByRole("searchbox");
    for (let index = 0; index < 35; index++) {
      await search.fill("笔记");
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      // 完整模型仍包含全部结果，可视区挂载数不随笔记库总量增长。
      expect(
        await files
          .getByRole("tree")
          .evaluate(
            (node) => document.getElementById(node.getAttribute("aria-describedby")!)?.textContent,
          ),
      ).toContain(String(folderCount * (filesPerFolder + 1)));
      expect(await files.getByRole("treeitem").count()).toBeLessThan(100);
      await search.press("ArrowDown");
      if (index === 0) {
        const edge = await files.locator(".file").evaluateAll((nodes) => {
          const tree = document.querySelector<HTMLElement>('.library [role="tree"]')!;
          const viewport = tree.getBoundingClientRect();
          const last = nodes
            .filter((node) => {
              const bounds = node.getBoundingClientRect();
              return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
            })
            .at(-1)!;
          return {
            path: last.getAttribute("data-path"),
            height: last.getBoundingClientRect().height,
            scroll: tree.scrollTop,
          };
        });
        await files.locator(`[data-path="${edge.path}"]`).focus();
        await page.keyboard.press("ArrowDown");
        const scrolled = await files.getByRole("tree").evaluate((node) => node.scrollTop);
        // 越过可视区边缘时只滚动一行，保留用户对前后文件的空间感。
        expect(scrolled - edge.scroll).toBeLessThanOrEqual(edge.height * 2);
      }
      await page.keyboard.press("End");
      const last = files.locator('[data-path="目录99/笔记99.md"]');
      expect(await last.evaluate((node) => node === document.activeElement)).toBe(true);
      expect(await last.getAttribute("aria-level")).toBe("2");
      expect(await last.getAttribute("aria-posinset")).toBe("100");
      expect(await last.getAttribute("aria-setsize")).toBe("100");
      expect(
        await last.evaluate((node) => {
          const row = node.getBoundingClientRect();
          const viewport = node.closest("[role=tree]")!.getBoundingClientRect();
          return row.top >= viewport.top && row.bottom <= viewport.bottom;
        }),
      ).toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
      expect(await page.getByRole("toolbar", { name: "资料整理" }).innerText()).toContain("10100");
      expect(await files.getByRole("treeitem").count()).toBeLessThan(100);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.keyboard.press("Escape");
      await search.fill("");
      expect(await files.getByRole("treeitem").count()).toBe(folderCount);
    }
    const measured = await latency.jsonValue();
    for (const [name, values] of Object.entries(measured)) {
      expect(values).toHaveLength(35);
      await checkBudget(
        name === "search"
          ? "file-filter"
          : name === "navigation"
            ? "file-navigation"
            : "file-selection",
        values.slice(5),
        100,
      );
    }
    await latency.dispose();

    await search.fill("笔记");
    await search.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    for (let step = 0; step < 45; step++) await page.keyboard.press("ArrowDown");
    const current = files.locator('[data-path="目录0/笔记45.md"]');
    expect(await current.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await current.getAttribute("aria-posinset")).toBe("46");
    const tree = files.getByRole("tree");
    await tree.evaluate((node) => {
      node.scrollTop = node.scrollHeight / 2;
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    // 滚轮浏览不卸载当前焦点，重新按方向键仍从原位置继续。
    expect(await current.evaluate((node) => node === document.activeElement)).toBe(true);
    const middle = files.locator('[data-path="目录50/笔记0.md"]');
    await middle.waitFor();
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await middle.focus();
    await middle.dispatchEvent("dragstart", { dataTransfer: transfer });
    await tree.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(await middle.getAttribute("class")).toContain("dragging");
    expect(await files.getByRole("treeitem").count()).toBeLessThan(100);
    await middle.dispatchEvent("dragend", { dataTransfer: transfer });
    await transfer.dispose();
    expect(await middle.getAttribute("class")).not.toContain("dragging");
    expect(await middle.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect(
      await files
        .locator('[data-path="目录50/笔记1.md"]')
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    const beforeHide = await tree.evaluate((node) => node.scrollTop);
    await page.getByRole("button", { name: "返回阅读与写作", exact: true }).click();
    await openLibrary(page);
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(beforeHide);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(640, 480);
    });
    await page.waitForFunction(() => window.innerWidth === 640);
    await search.press("ArrowDown");
    await page.keyboard.press("End");
    expect(
      await files.locator('[data-path="目录99/笔记99.md"]').evaluate((node) => {
        const row = node.getBoundingClientRect();
        const viewport = node.closest('[role="tree"]')!.getBoundingClientRect();
        return (
          node === document.activeElement &&
          row.top >= viewport.top &&
          row.bottom <= viewport.bottom
        );
      }),
    ).toBe(true);
    expect(await files.getByRole("treeitem").count()).toBeLessThan(100);
    const accessibility = await page.context().newCDPSession(page);
    const snapshot = await accessibility.send("Accessibility.getFullAXTree");
    const directory = snapshot.nodes.find((node) => node.role?.value === "tree");
    expect(directory?.name?.value).toBe("笔记库目录");
    expect(directory?.description?.value).toContain("10100");
    const focusedRow = snapshot.nodes.find(
      (node) =>
        node.role?.value === "treeitem" &&
        node.properties?.some(
          (property) => property.name === "focused" && property.value.value === true,
        ),
    );
    expect(focusedRow?.name?.value).toBe("笔记99.md");
    expect(focusedRow?.properties?.find((property) => property.name === "level")?.value.value).toBe(
      2,
    );
    await accessibility.detach();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
