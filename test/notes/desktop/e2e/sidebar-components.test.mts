import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { documentTools, openLibrary, sidebarComponent } from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("组件栏固定在侧栏顶部，滚动与键盘可达，面板切换保留查询及正文", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-components-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  await writeFile(
    join(vault, "阅读.md"),
    "# 阅读\n\n当前正文。\n\n## 第一节\n\n保留阅读位置。\n\n## 第二节\n\n继续阅读。\n",
  );
  await mkdir(join(vault, "资料"));
  await mkdir(join(vault, "资料/子目录"));
  await writeFile(join(vault, "资料/里面.md"), "# 里面\n\n网格文件夹中的笔记。\n");
  await writeFile(join(vault, "资料/子目录/深处.md"), "# 深处\n\n侧栏与网格共享目录。\n");
  await writeFile(join(vault, "想法.md"), "# 想法\n\n组件切换不会清空搜索。\n");
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      reader: {
        vaultRoot: vault,
        currentPath: "阅读.md",
        mode: "reading",
        filesCollapsed: false,
        leftWidth: 192,
        destination: "graph",
        space: "connections",
      },
    }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const app = await electron.launch({
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
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 760),
    );
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    const original = await editor.elementHandle();
    const bar = page.getByRole("toolbar", { name: "组件栏", exact: true });
    const sidebar = page.locator(".file-sidebar");
    expect((await bar.boundingBox())!.y).toBeLessThan((await sidebar.boundingBox())!.y + 10);
    expect(await bar.getByRole("button").count()).toBe(3);

    const resize = page.getByRole("separator", { name: "调整侧栏宽度", exact: true });
    const savedWidth = async () =>
      JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.leftWidth;
    await resize.focus();
    await resize.press("ArrowRight");
    await expect.poll(savedWidth).toBe(202);
    await resize.dblclick();
    await expect.poll(savedWidth).toBe(232);
    const grip = (await resize.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 80);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 28, grip.y + 80, { steps: 6 });
    expect(await resize.getAttribute("aria-valuenow")).toBe("260");
    expect(await savedWidth()).toBe(232);
    await page.mouse.up();
    await expect.poll(savedWidth).toBe(260);

    await sidebarComponent(page, "搜索");
    const search = page.getByRole("searchbox", { name: "搜索文件和全文", exact: true });
    await search.fill("组件切换");
    await page.locator(".search-content .hit").waitFor();
    await sidebarComponent(page, "目录");
    await page
      .locator(".outline-sidebar")
      .getByRole("button", { name: "第一节", exact: true })
      .waitFor();
    expect(await page.locator(".quick-navigation").isVisible()).toBe(false);
    expect(await page.locator(".editor-tools").isVisible()).toBe(true);
    await sidebarComponent(page, "目录");
    await sidebarComponent(page, "搜索");
    expect(await search.inputValue()).toBe("组件切换");
    expect(await editor.evaluate((node, original) => node === original, original)).toBe(true);

    await openLibrary(page);
    const folders = page.getByRole("navigation", { name: "文件夹导航", exact: true });
    expect(await folders.isVisible()).toBe(true);
    expect(await folders.getByRole("treeitem", { name: "资料", exact: true }).isVisible()).toBe(true);
    const grid = page.getByRole("grid", { name: "文件系统", exact: true });
    expect(Number(await grid.getAttribute("aria-colcount"))).toBeGreaterThanOrEqual(2);
    // 两次采样要比较布局终态，不能比较进入动画的不同帧。
    await page.waitForFunction(() =>
      document.querySelector(".library")?.getAnimations().every((animation) => animation.playState === "finished"),
    );
    const a = await grid.locator('[data-path="想法.md"]').boundingBox();
    const b = await grid.locator('[data-path="资料"]').boundingBox();
    expect(a!.y).toBe(b!.y);
    expect(a!.x).not.toBe(b!.x);
    if (process.env.NOEMORI_FILE_GRID_SCREENSHOT)
      await page.screenshot({ path: process.env.NOEMORI_FILE_GRID_SCREENSHOT });
    await grid.getByRole("button", { name: "资料", exact: true }).click();
    expect(await grid.getByRole("button", { name: "里面.md", exact: true }).count()).toBe(0);
    await grid.getByRole("button", { name: "资料", exact: true }).dblclick();
    await grid.getByRole("button", { name: "里面.md", exact: true }).waitFor();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.fileTree.browse
            .directory,
      )
      .toBe("资料");
    expect(await folders.getByRole("treeitem", { name: "资料", exact: true }).getAttribute("aria-current")).toBe("location");
    await folders.getByRole("treeitem", { name: "子目录", exact: true }).press("Enter");
    await grid.getByRole("button", { name: "深处.md", exact: true }).waitFor();
    expect(await folders.getByRole("treeitem", { name: "子目录", exact: true }).getAttribute("aria-current")).toBe("location");
    expect(await editor.evaluate((node, original) => node === original, original)).toBe(true);
    await page.locator(".breadcrumbs").getByRole("button", { name: "资料", exact: true }).click();
    await grid.getByRole("button", { name: "里面.md", exact: true }).waitFor();
    expect(await folders.getByRole("treeitem", { name: "资料", exact: true }).getAttribute("aria-current")).toBe("location");
    await page.locator(".root-label").click();
    await grid.getByRole("button", { name: "阅读.md", exact: true }).waitFor();
    expect(await page.locator(".quick-navigation").isVisible()).toBe(false);
    expect(
      await bar.getByRole("button", { name: "文件系统", exact: true }).getAttribute("aria-pressed"),
    ).toBe("true");
    await sidebarComponent(page, "搜索");
    expect(await search.isVisible()).toBe(true);
    expect(await search.inputValue()).toBe("组件切换");
    expect(await grid.isVisible()).toBe(true);
    expect(await search.evaluate((node) => node === document.activeElement)).toBe(true);
    await sidebarComponent(page, "文件系统");
    await page.locator(".library").getByRole("button", { name: "书签", exact: true }).click();
    await page.locator(".library .bookmarks").waitFor();
    await sidebarComponent(page, "目录");
    expect(await editor.evaluate((node, original) => node === original, original)).toBe(true);

    expect(await bar.getByRole("button").count()).toBe(3);
    expect(await page.getByRole("button", { name: "所有组件", exact: true }).count()).toBe(0);
    await sidebarComponent(page, "目录");
    await page.locator(".outline-sidebar").waitFor();
    expect(
      await bar.getByRole("button", { name: "目录", exact: true }).getAttribute("aria-pressed"),
    ).toBe("true");
    await bar.getByRole("button", { name: "目录", exact: true }).focus();
    await page.keyboard.press("Home");
    expect(
      await bar
        .getByRole("button", { name: "目录", exact: true })
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    expect(await search.isVisible()).toBe(true);
    expect(await search.inputValue()).toBe("组件切换");

    await documentTools(page);
    expect(await page.locator(".mode-switch").count()).toBe(0);
    await page.getByRole("toolbar", { name: "编辑工具栏", exact: true }).waitFor();
    const toolbarBounds = (await page
      .getByRole("toolbar", { name: "编辑工具栏", exact: true })
      .boundingBox())!;
    const windowBounds = (await page.locator(".window-toolbar").boundingBox())!;
    expect(toolbarBounds.y).toBeGreaterThanOrEqual(windowBounds.y);
    expect(toolbarBounds.y + toolbarBounds.height).toBeLessThanOrEqual(
      windowBounds.y + windowBounds.height,
    );
    expect(await page.locator(".pane-column [role=toolbar]").count()).toBe(0);
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    expect(await page.getByRole("toolbar", { name: "编辑工具栏", exact: true }).isVisible()).toBe(
      true,
    );
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    expect(await page.getByRole("toolbar", { name: "编辑工具栏", exact: true }).isVisible()).toBe(
      true,
    );
    await sidebarComponent(page, "目录");
    await sidebarComponent(page, "文件系统");
    expect(
      await bar.getByRole("button", { name: "文件系统", exact: true }).getAttribute("aria-pressed"),
    ).toBe("true");
    await sidebarComponent(page, "目录");
    expect(await page.getByRole("button", { name: /图谱/u }).count()).toBe(0);
    await page.getByRole("button", { name: "双链", exact: true }).click();
    expect(await page.locator(".graph-popover").count()).toBe(0);
    const links = page.getByRole("region", { name: "双链面板", exact: true });
    const heightHandle = page.getByRole("separator", { name: "调整双链高度", exact: true });
    await page.waitForFunction(() =>
      document.querySelector(".dock-panel")?.getAnimations().every((animation) => animation.playState === "finished"),
    );
    const initialHeight = (await links.boundingBox())!.height;
    const dockBottom = (await page
      .getByRole("button", { name: "双链", exact: true })
      .boundingBox())!.y;
    const linksGrip = (await heightHandle.boundingBox())!;
    await page.mouse.move(linksGrip.x + linksGrip.width / 2, linksGrip.y + linksGrip.height / 2);
    await page.mouse.down();
    await page.mouse.move(linksGrip.x + linksGrip.width / 2, linksGrip.y + linksGrip.height / 2 - 80, {
      steps: 5,
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await links.boundingBox())!.height)
      .toBeCloseTo(initialHeight + 80, 0);
    expect(
      (await page.getByRole("button", { name: "双链", exact: true }).boundingBox())!.y,
    ).toBeCloseTo(dockBottom, 0);
    await page.getByRole("button", { name: "双链", exact: true }).click();
    await page.getByRole("button", { name: "双链", exact: true }).click();
    await expect.poll(async () => (await links.boundingBox())!.height).toBeCloseTo(initialHeight + 80, 0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 480),
    );
    await expect.poll(async () => (await links.boundingBox())!.height).toBeLessThan(initialHeight);
    await expect.poll(async () => (await links.boundingBox())!.height).toBeLessThanOrEqual(
      Number(await heightHandle.getAttribute("aria-valuemax")),
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 760),
    );
    await expect
      .poll(async () => (await links.boundingBox())!.height)
      .toBeCloseTo(initialHeight + 80, 0);
    await heightHandle.dblclick();
    await expect
      .poll(async () => (await links.boundingBox())!.height)
      .toBeCloseTo(initialHeight, 0);
    if (process.env.NOEMORI_COMPONENTS_SCREENSHOT) {
      await sidebarComponent(page, "目录");
      await page.screenshot({ path: process.env.NOEMORI_COMPONENTS_SCREENSHOT });
    }
    await page.setViewportSize({ width: 600, height: 700 });
    await page.getByRole("button", { name: "收起文件栏", exact: true }).waitFor();
    await sidebarComponent(page, "文件系统");
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    await folders.getByRole("treeitem", { name: "资料", exact: true }).click();
    await page.getByRole("complementary", { name: "文件栏", exact: true }).waitFor({ state: "hidden" });
    expect(await grid.getByRole("button", { name: "里面.md", exact: true }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
