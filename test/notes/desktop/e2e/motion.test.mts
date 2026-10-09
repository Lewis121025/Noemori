import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron, type Locator, type Page } from "playwright-core";
import { openLibrary, sidebarComponent } from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState === "finished"),
  );
}

// 冻结浏览器生成的真实中间帧，避免用固定 sleep 把掉帧或瞬间切换误判为过渡。
async function midpoint(locator: Locator) {
  return locator.evaluate((element) => {
    const animations = element.getAnimations();
    for (const animation of animations) {
      const duration = animation.effect?.getTiming().duration;
      if (typeof duration !== "number") throw new Error("动效没有确定时长");
      animation.pause();
      animation.currentTime = duration * 0.35;
    }
    const style = getComputedStyle(element);
    return {
      count: animations.length,
      duration: Math.max(
        ...animations.map((animation) => Number(animation.effect?.getTiming().duration)),
      ),
      opacity: Number(style.opacity),
      width: element.getBoundingClientRect().width,
      left: element.getBoundingClientRect().left,
      inert: element instanceof HTMLElement && element.inert,
    };
  });
}

async function resume(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const animation of document.getAnimations())
      if (animation.playState === "paused") animation.play();
  });
}

test("动效支持中途反向、原生焦点交接和减少动态效果，保留正文会话", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-motion-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source =
    "# 森林里的阅读\n\n" +
    Array.from(
      { length: 40 },
      (_, i) => `## 章节 ${i}\n\n${"在安静的页面中，保持思考的连续。".repeat(8)}\n\n`,
    ).join("");
  await Promise.all([
    writeFile(join(vault, "forest.md"), source),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({
        appearance: "light",
        readingPalette: "green",
        reader: { vaultRoot: vault, currentPath: "forest.md", filesCollapsed: false },
      }),
    ),
  ]);
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
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    await settle(page);
    expect(
      await page
        .locator(".dock-actions")
        .evaluate((element) => element.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    const identity = await editor.elementHandle();
    await page.locator(".main").evaluate((element) => {
      element.scrollTop = 700;
    });
    const top = await page.locator(".main").evaluate((element) => element.scrollTop);

    const settingsButton = page.getByRole("button", { name: "设置", exact: true });
    await settingsButton.click();
    const settings = page.locator(".settings-window");
    const frame = await midpoint(settings);
    expect(frame.count).toBeGreaterThan(0);
    expect(frame.duration).toBe(260);
    expect(frame.opacity).toBeGreaterThan(0);
    expect(frame.opacity).toBeLessThan(1);
    // Esc 在动画未完成时仍须关闭，且不能等退出动画才释放焦点。
    await page.keyboard.press("Escape");
    expect(await settings.getAttribute("open")).toBeNull();
    await expect
      .poll(() => settingsButton.evaluate((button) => document.activeElement === button))
      .toBe(true);
    await settingsButton.click();
    await resume(page);
    await settle(page);
    expect(await settings.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    await page.getByRole("button", { name: "外观与阅读", exact: true }).click();
    await page.keyboard.press("Escape");
    await settle(page);
    expect(await page.locator(".main").evaluate((element) => element.scrollTop)).toBe(top);

    const more = page.getByRole("button", { name: "笔记操作", exact: true });
    await more.click();
    const menu = page.locator(".topbar-document:not([hidden]) .note-menu");
    expect((await midpoint(menu)).count).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    expect(await menu.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    await more.click();
    await resume(page);
    await settle(page);
    expect(await page.locator(":popover-open").count()).toBe(1);
    await page.keyboard.press("Escape");
    await settle(page);

    const toggle = page.getByRole("button", { name: "显示或隐藏文件栏", exact: true });
    const sidebar = page.locator(".file-sidebar:not(.right)");
    const width = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
    await toggle.click();
    const collapsing = await midpoint(sidebar);
    expect(collapsing.inert).toBe(true);
    expect(collapsing.width).toBe(width);
    expect(collapsing.left).toBeLessThan(0);
    expect(collapsing.left).toBeGreaterThan(-width);
    expect(
      await page
        .locator(".pane-content")
        .evaluate((element) =>
          element
            .getAnimations()
            .some(
              (animation) =>
                animation.effect instanceof KeyframeEffect &&
                animation.effect.getKeyframes().some((frame) => frame.translate !== undefined),
            ),
        ),
    ).toBe(true);
    await toggle.click();
    await resume(page);
    await settle(page);
    expect(await sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(width);
    expect(await sidebar.getAttribute("inert")).toBeNull();

    const dockToggle = page.getByRole("button", { name: "双链", exact: true });
    await dockToggle.click();
    await settle(page);
    await dockToggle.click();
    expect((await midpoint(page.locator(".dock-panel"))).inert).toBe(true);
    await dockToggle.click();
    await resume(page);
    await settle(page);
    expect(await page.getByRole("region", { name: "双链面板", exact: true }).isVisible()).toBe(
      true,
    );

    await sidebarComponent(page, "搜索");
    await page.getByRole("searchbox", { name: "搜索笔记库" }).fill("连续");
    await sidebarComponent(page, "目录");
    await openLibrary(page);
    await sidebarComponent(page, "目录");
    await settle(page);
    expect(
      await identity?.evaluate((node) => node === document.querySelector(".ProseMirror")),
    ).toBe(true);
    await sidebarComponent(page, "搜索");
    expect(await page.getByRole("searchbox", { name: "搜索笔记库" }).inputValue()).toBe("连续");

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(640, 800),
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(640);
    await toggle.click();
    await settle(page);
    await toggle.click();
    const drawer = await midpoint(sidebar);
    expect(drawer.count).toBeGreaterThan(0);
    expect(await page.locator(".content-space").getAttribute("inert")).not.toBeNull();
    await page.keyboard.press("Escape");
    await resume(page);
    await settle(page);
    expect(await sidebar.isVisible()).toBe(false);
    expect(await page.locator(".content-space").getAttribute("inert")).toBeNull();
    expect(await page.locator(".files-scrim").isVisible()).toBe(false);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await toggle.click();
    await settingsButton.click();
    expect(await settings.evaluate((element) => element.getAnimations().length)).toBe(0);
    await page.getByRole("button", { name: "黑白", exact: true }).click();
    await expect
      .poll(() => page.locator(".app").getAttribute("data-reading-palette"))
      .toBe("monochrome");
    expect(
      await sidebar.evaluate((element) => getComputedStyle(element, "::before").backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    expect(await settings.evaluate((element) => getComputedStyle(element).translate)).toBe("none");
    await page.keyboard.press("Escape");
    expect(await settings.isVisible()).toBe(false);
    await toggle.click();
    expect(await sidebar.isVisible()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await readFile(join(vault, "forest.md"), "utf8")).toBe(source);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
