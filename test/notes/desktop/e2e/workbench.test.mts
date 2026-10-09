import { documentTools, openSplit, sidebarComponent } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("统一工作台：侧栏搜索、文内工具、分栏与目录状态形成连续操作路径", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-workbench-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  await writeFile(
    join(vault, "甲.md"),
    "# 甲文档\n\n" +
      Array.from({ length: 30 }, (_, i) => `## 章节${i}\n\n这里是测试工作台的内容。\n\n`).join(""),
  );
  await writeFile(join(vault, "乙.md"), "# 乙文档\n\n苹果香蕉\n\n## 第二节\n\n内容\n");
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({ reader: { vaultRoot: vault, currentPath: "甲.md", mode: "editing" } }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const launch = () =>
    electron.launch({
      executablePath,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${state}`,
        "--no-sandbox",
      ],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
        ),
      ),
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const resize = async (width: number) => {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 800),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    };
    await page.locator(".ProseMirror").waitFor();
    await resize(1100);
    await documentTools(page);
    const sidebar = page.locator(".file-sidebar:not(.right)");
    const controls = page.locator(".topbar-document:not([hidden])");
    expect(await page.locator(".mode-switch").count()).toBe(0);
    expect(
      await page.locator(".pane-column .document-bar, .pane-column [role=toolbar]").count(),
    ).toBe(0);
    expect(await page.locator(".pane-column button:visible").count()).toBe(0);
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).waitFor();
    await expect.poll(() => sidebar.isVisible()).toBe(false);
    expect(await page.locator(".content-space button:visible").count()).toBe(0);
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    await controls.getByRole("toolbar", { name: "编辑工具栏", exact: true }).waitFor();
    await controls.getByRole("button", { name: "文内查找", exact: true }).click();
    await controls.getByRole("searchbox", { name: "查找", exact: true }).fill("工作台");
    await controls.getByRole("button", { name: "下一处", exact: true }).click();
    expect(await page.locator(".main .search-panel").count()).toBe(0);
    await controls.getByRole("button", { name: "关闭查找", exact: true }).click();
    await sidebarComponent(page, "搜索");
    await page.getByRole("searchbox", { name: "搜索笔记库", exact: true }).fill("苹果");
    await page.locator('.library .file[data-path="乙.md"]').waitFor();
    await page.locator('.library .file[data-path="乙.md"]').click();
    await expect.poll(() => controls.locator(".document-name").textContent()).toBe("乙.md");
    await sidebarComponent(page, "目录");
    await documentTools(page);
    await openSplit(page);
    await page.locator("dialog.picker[open]").getByRole("combobox").fill("甲");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".pane-column").count()).toBe(2);
    await expect.poll(() => controls.locator(".document-name").textContent()).toBe("甲.md");
    const pane = page.locator(".pane-column.active");
    await sidebarComponent(page, "目录");
    const outline = sidebar.locator(".sidebar-document:not([hidden]) .outline-sidebar");
    await outline
      .getByRole("button", { name: "章节20", exact: true })
      .click();
    await expect
      .poll(() => outline.locator('[aria-current="location"]').textContent())
      .toBe("章节20");
    await documentTools(page);
    for (const width of [640, 860, 1100, 1440]) {
      await resize(width);
      const toolbar = controls.getByRole("toolbar", { name: "编辑工具栏", exact: true });
      await toolbar.scrollIntoViewIfNeeded();
      const box = (await toolbar.boundingBox())!;
      const header = (await page.locator(".window-toolbar").boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(header.y);
      expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height);
      expect(
        await page.locator(".pane-column [role=toolbar], .pane-column .outline-sidebar").count(),
      ).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }

    await sidebarComponent(page, "搜索");
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.sidebarView,
      )
      .toBe("files");
    expect(await pane.locator(".ProseMirror").isVisible()).toBe(true);
    if (process.env.NOEMORI_WORKBENCH_SCREENSHOT) {
      await page.screenshot({ path: process.env.NOEMORI_WORKBENCH_SCREENSHOT });
    }
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.locator(".pane-column.active .ProseMirror").waitFor();
    await resize(2400);
    expect(await page.getByRole("searchbox", { name: "搜索笔记库" }).inputValue()).toBe("苹果");
    const restored = page.locator(".topbar-document:not([hidden])");
    expect(await restored.locator(".document-name").textContent()).toBe("甲.md");
    expect(
      await page
        .getByRole("button", { name: "文件目录", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
