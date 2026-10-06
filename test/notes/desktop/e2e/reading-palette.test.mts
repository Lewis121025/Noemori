import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron, type Page } from "playwright-core";
import {
  noteAction,
  openLibrary,
  openSettings,
  sidebarComponent,
} from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

async function documentMetrics(page: Page) {
  return page.locator(".ProseMirror").evaluateAll((editors) =>
    editors.map((editor) => {
      const heading = editor.querySelector("h1");
      const main = editor.closest(".main");
      if (!heading || !main) throw new Error("缺少文档表面");
      return {
        color: getComputedStyle(heading).color,
        size: getComputedStyle(editor).fontSize,
        font: getComputedStyle(editor).fontFamily,
        top: main.scrollTop,
        width: editor.getBoundingClientRect().width,
      };
    }),
  );
}

async function interfaceFrame(page: Page) {
  return page.locator(".app").evaluate((app) => {
    const toolbar = app.querySelector(".window-toolbar");
    const sidebar = app.querySelector(".component-bar");
    if (!toolbar || !sidebar) throw new Error("缺少界面框架");
    return {
      toolbar: getComputedStyle(toolbar).backgroundColor,
      sidebar: getComputedStyle(sidebar).backgroundColor,
    };
  });
}

test("配色默认黑白，覆盖阅读与管理界面，双栏切换保留布局且跨重启恢复", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-reading-palette-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source =
    "# 阅读配色\n\n" +
    Array.from(
      { length: 60 },
      (_, index) => `第 ${index} 段。${"清晰的文字，让思考保持连续。".repeat(6)}`,
    ).join("\n\n") +
    "\n";
  const sessionFile = join(state, "session.json");
  await Promise.all([
    writeFile(join(vault, "a.md"), source),
    writeFile(join(vault, "b.md"), source),
    writeFile(
      sessionFile,
      JSON.stringify({
        appearance: "light",
        readingFont: "lora",
        reader: {
          vaultRoot: vault,
          filesCollapsed: false,
          documents: {
            panes: ["a.md", "b.md"].map((currentPath) => ({
              currentPath,
              history: { back: [], forward: [] },
            })),
            active: 0,
            split: true,
          },
        },
      }),
    ),
  ]);
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron 可执行文件");
  const launch = () =>
    electron.launch({
      executablePath,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${state}`,
        "--no-sandbox",
      ],
      colorScheme: null,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
        ),
      ),
    });
  let app = await launch();
  const errors: string[] = [];
  try {
    let page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("应用窗口不存在");
      window.setContentSize(1400, 900);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1400);
    await expect.poll(() => page.locator(".ProseMirror").count()).toBe(2);
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    const neutralFrame = await interfaceFrame(page);
    const paper = await page
      .locator(".document-body")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await openSettings(page);
    let palettes = page.getByRole("group", { name: "阅读配色", exact: true });
    await expect.poll(() => palettes.getAttribute("aria-busy")).toBe("false");
    await expect
      .poll(() =>
        page.getByRole("group", { name: "阅读字体", exact: true }).getAttribute("aria-busy"),
      )
      .toBe("false");
    expect(await palettes.getByRole("button").count()).toBe(2);
    expect(
      await palettes
        .getByRole("button", { name: "黑白", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect((await documentMetrics(page)).map((metric) => metric.color)).toEqual([
      "rgb(17, 17, 17)",
      "rgb(17, 17, 17)",
    ]);
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.locator(".main").evaluateAll((mains) => {
      mains.forEach((main, index) => {
        main.scrollTop = 800 + index * 400;
      });
    });
    const before = await documentMetrics(page);
    const first = await page.locator(".ProseMirror").first().elementHandle();
    if (!first) throw new Error("缺少原文档节点");
    await openSettings(page);
    await palettes.getByRole("button", { name: "绿色", exact: true }).click();
    await expect
      .poll(() => page.locator(".app").getAttribute("data-reading-palette"))
      .toBe("green");
    await expect
      .poll(async () => JSON.parse(await readFile(sessionFile, "utf8")).readingPalette)
      .toBe("green");
    const green = await documentMetrics(page);
    for (const [index, metric] of green.entries()) {
      // 验证标题呈现可辨认的绿色，不把具体色值锁死，允许后续视觉校准。
      const [red, greenChannel, blue] = metric.color.match(/\d+/g)?.map(Number) ?? [];
      if (red === undefined || greenChannel === undefined || blue === undefined)
        throw new Error("标题颜色不是有效的 RGB");
      expect(greenChannel - Math.max(red, blue)).toBeGreaterThan(20);
      expect({ ...metric, color: before[index]?.color }).toEqual(before[index]);
    }
    expect(
      await page
        .locator(".ProseMirror")
        .first()
        .evaluate((node, original) => node === original, first),
    ).toBe(true);

    // 配色覆盖整套界面，文档纸面保持中性；切换空间不能退回默认界面颜色。
    const greenFrame = await interfaceFrame(page);
    expect(greenFrame.toolbar).not.toBe(neutralFrame.toolbar);
    expect(greenFrame.sidebar).not.toBe(neutralFrame.sidebar);
    expect(
      await page
        .locator(".document-body")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe(paper);
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await noteAction(page, "切换源码视图");
    await expect.poll(() => page.locator(".cm-editor").count()).toBe(1);
    expect(await interfaceFrame(page)).toEqual(greenFrame);
    await noteAction(page, "切换排版视图");
    await expect.poll(() => page.locator(".cm-editor").count()).toBe(0);
    await openLibrary(page);
    expect(await interfaceFrame(page)).toEqual(greenFrame);
    await sidebarComponent(page, "目录");
    await openSettings(page);

    // 通过真实 IPC 拒绝未知选项，不能把会话悄悄回退为另一种配色。
    const invalid = await page.evaluate(async () => {
      try {
        await Reflect.apply(window.noemori.app.readingPaletteSet, undefined, ["blue"]);
        return "accepted";
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    });
    expect(invalid).toContain("无效的阅读配色");
    expect(JSON.parse(await readFile(sessionFile, "utf8")).readingPalette).toBe("green");
    await palettes.getByRole("button", { name: "黑白", exact: true }).click();
    await expect
      .poll(() => page.locator(".app").getAttribute("data-reading-palette"))
      .toBe("monochrome");
    await palettes.getByRole("button", { name: "绿色", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.locator(".app").getAttribute("data-reading-palette"))
      .toBe("green");
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("dark");
    expect(await page.locator(".app").getAttribute("data-reading-palette")).toBe("green");
    expect(await page.evaluate(() => window.noemori.app.readingFontGet())).toBe("lora");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect
      .poll(() => page.locator(".app").getAttribute("data-reading-palette"))
      .toBe("green");
    await openSettings(page);
    palettes = page.getByRole("group", { name: "阅读配色", exact: true });
    await expect.poll(() => palettes.getAttribute("aria-busy")).toBe("false");
    expect(
      await palettes
        .getByRole("button", { name: "绿色", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
    expect(await readFile(join(vault, "a.md"), "utf8")).toBe(source);
    expect(await readFile(join(vault, "b.md"), "utf8")).toBe(source);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
