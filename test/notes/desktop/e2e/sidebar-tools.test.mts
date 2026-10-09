import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("精简目录保留文件夹管理，更多菜单在窄侧栏可达，收藏入口完整移除", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-sidebar-tools-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "NNDL-Bilingual"),
    state = join(root, "state");
  const longName = "03-Improving-the-Way-Neural-Networks-Learn.md";
  await mkdir(join(vault, "章节"), { recursive: true });
  await mkdir(join(vault, "assets"));
  await mkdir(join(vault, "attachments"));
  await mkdir(state);
  await Promise.all([
    writeFile(
      join(vault, "首页.md"),
      "# 神经网络与深度学习\n\n理解知识，也让知识之间建立联系。\n\n## 前言\n\n安静地阅读。\n",
    ),
    writeFile(join(vault, "章节/第一章.md"), "# 第一章\n\n从基础开始。\n"),
    ...[
      "00-README.md",
      "01-Using-Neural-Nets-to-Recognize-Handwritten-Digits.md",
      "02-How-the-Backpropagation-Algorithm-Works.md",
      longName,
      "04-A-Visual-Proof-That-Neural-Nets-Can-Compute-Any-Function.md",
      "05-Why-Are-Deep-Neural-Networks-Hard-to-Train.md",
      "06-Deep-Learning.md",
    ].map((name) =>
      writeFile(
        join(vault, name),
        "# 改进神经网络的学习方式\n\n理解知识，也让知识之间建立联系。\n\n## 交叉熵代价函数\n\n从误差开始改进。\n",
      ),
    ),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({
        appearance: "light",
        readingPalette: "green",
        reader: { vaultRoot: vault, currentPath: longName, filesCollapsed: false, leftWidth: 232 },
      }),
    ),
  ]);
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const app = await electron.launch({
    executablePath,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
    // focus-visible 属于真实窗口的键盘模态，不能依赖后台窗口的焦点模拟。
    env: { ...process.env, ELECTRON_RENDERER_URL: "", NOEMORI_TEST_WINDOW: "visible" },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".ProseMirror").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const sidebar = page.locator(".file-sidebar:not(.right)");
    const headingNavigation = sidebar.locator(".navigation-heading");
    const filesButton = headingNavigation.getByRole("button", { name: "文件目录", exact: true });
    const outlineButton = headingNavigation.getByRole("button", { name: "文章大纲", exact: true });
    const searchInput = sidebar.getByRole("searchbox", { name: "搜索笔记库", exact: true });
    expect(
      await headingNavigation.getByRole("button", { name: "搜索笔记库", exact: true }).count(),
    ).toBe(0);
    await searchInput.fill("首页");
    await outlineButton.click();
    expect(await filesButton.isVisible()).toBe(true);
    await filesButton.press("Enter");
    expect(await searchInput.inputValue()).toBe("首页");
    await searchInput.waitFor({ state: "visible" });
    await searchInput.focus();
    await searchInput.press("Escape");
    const heading = sidebar.locator(".view-options");
    const more = heading.getByRole("button", { name: "目录操作", exact: true });
    const menu = sidebar.locator(".options-menu");
    const row = (path: string) => sidebar.locator(`.file[data-path="${path}"]`);
    await row(longName).focus();
    await row(longName).press("ArrowDown");
    expect(
      await row(longName).evaluate((element) => getComputedStyle(element.parentElement!).boxShadow),
    ).toContain("inset");
    expect(
      await row("04-A-Visual-Proof-That-Neural-Nets-Can-Compute-Any-Function.md").evaluate(
        (element) => getComputedStyle(element.parentElement!).boxShadow,
      ),
    ).toBe("none");
    expect(await sidebar.locator(".file-row.active .file").getAttribute("data-path")).toBe(
      longName,
    );
    const completeName = sidebar.getByRole("tooltip");
    await completeName.waitFor();
    expect(await completeName.textContent()).toContain(
      "04-A-Visual-Proof-That-Neural-Nets-Can-Compute-Any-Function.md",
    );
    const hintBounds = (await completeName.boundingBox())!;
    expect(hintBounds.x).toBeGreaterThanOrEqual(0);
    expect(hintBounds.x + hintBounds.width).toBeLessThanOrEqual(
      await page.evaluate(() => innerWidth),
    );
    await page.keyboard.press("Escape");
    await completeName.waitFor({ state: "hidden" });
    expect(await heading.locator(":scope > button").count()).toBe(1);
    expect(await heading.locator(".root-label h2").textContent()).toBe("Noemori");
    expect(await heading.getByRole("button", { name: "笔记库根目录" }).count()).toBe(0);
    expect(await heading.locator(".result-count").count()).toBe(0);
    expect(await sidebar.getByRole("button", { name: /浏览标签|书签|定位当前文件/ }).count()).toBe(
      0,
    );
    expect(await sidebar.getByRole("combobox", { name: "文件排序" }).count()).toBe(0);

    await more.focus();
    await more.press("Enter");
    await menu.waitFor();
    await menu.getByRole("button", { name: "展开全部目录", exact: true }).click();
    await row("章节/第一章.md").waitFor();
    await more.click();
    await menu.getByRole("button", { name: "折叠全部目录", exact: true }).click();
    await row("章节/第一章.md").waitFor({ state: "detached" });
    await more.click();
    const archived = menu.getByRole("button", { name: "显示归档对话", exact: true });
    await archived.click();
    expect(await archived.getAttribute("aria-pressed")).toBe("true");
    await archived.click();
    expect(await archived.getAttribute("aria-pressed")).toBe("false");
    await page.keyboard.press("Escape");
    expect(await menu.isVisible()).toBe(false);
    expect(await more.evaluate((element) => element === document.activeElement)).toBe(true);

    await row("首页.md").click({ button: "right" });
    const context = page.getByRole("menu", { name: "文件操作", exact: true });
    await context.waitFor();
    expect(await context.getByRole("menuitem", { name: /收藏|书签/ }).count()).toBe(0);
    expect(await context.getByRole("menuitem", { name: "移动到…", exact: true }).isVisible()).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+p");
    const commands = page.getByRole("dialog", { name: "命令面板", exact: true });
    await commands.waitFor();
    expect(await commands.getByRole("option", { name: /收藏|书签/ }).count()).toBe(0);
    await page.keyboard.press("Escape");

    const captures = process.env.NOEMORI_SIDEBAR_SCREENSHOTS;
    if (captures) await page.screenshot({ path: join(captures, "sidebar-green.png") });
    await page.getByRole("separator", { name: "调整侧栏宽度", exact: true }).press("Home");
    const sidebarBounds = (await sidebar.boundingBox())!;
    for (const button of [
      filesButton,
      outlineButton,
      headingNavigation.getByRole("button", { name: "新建", exact: true }),
    ]) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(sidebarBounds.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(sidebarBounds.x + sidebarBounds.width);
    }
    await more.click();
    await menu.waitFor();
    const bounds = (await menu.boundingBox())!;
    const buttonBounds = (await more.boundingBox())!;
    expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(
      sidebarBounds.x + sidebarBounds.width,
    );
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    if (captures) await page.screenshot({ path: join(captures, "sidebar-narrow-menu.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
