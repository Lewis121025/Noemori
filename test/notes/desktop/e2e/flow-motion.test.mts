import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test, type TestContext } from "vitest";
import { _electron as electron, type Page } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

async function launch(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "noemori-flow-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source =
    "# 流动\n\n连续地阅读和书写。\n\n## 连接\n\n保持当前的注意力。\n" +
    Array.from(
      { length: 120 },
      (_, index) => `\n## 片段 ${index}\n\n${"长文中的注意力与编辑位置保持连续。".repeat(4)}\n`,
    ).join("");
  await Promise.all([
    writeFile(join(vault, "流动.md"), source),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ appearance: "light", reader: { vaultRoot: vault, currentPath: "流动.md" } }),
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
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.onTestFinished(() => expect(errors).toEqual([]));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".ProseMirror").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().length === 0);
  return { app, page, vault, source };
}

async function sampleLayout(page: Page, trigger: () => Promise<void>) {
  const [frames] = await Promise.all([
    page.locator(".document-body").evaluate(async (body) => {
      const values: { left: number; width: number }[] = [];
      const scroller = body.closest(".main");
      if (!(scroller instanceof HTMLElement)) throw new Error("缺少滚动区");
      for (let frame = 0; frame < 24; frame += 1) {
        await new Promise(requestAnimationFrame);
        values.push({ left: body.getBoundingClientRect().left, width: scroller.clientWidth });
      }
      return values;
    }),
    trigger(),
  ]);
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const destination = await page
    .locator(".document-body")
    .evaluate((body) => body.getBoundingClientRect().left);
  const direction = Math.sign(destination - frames[0]!.left);
  expect(direction).not.toBe(0);
  // 整段轨迹只能朝终点前进，不能先闪到终点再拉回动画起点。
  for (let index = 1; index < frames.length; index += 1)
    expect((frames[index]!.left - frames[index - 1]!.left) * direction).toBeGreaterThanOrEqual(
      -0.5,
    );
  expect(new Set(frames.map((frame) => frame.width)).size).toBeLessThanOrEqual(2);
}

async function entryOffset(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((node) => {
    const effect = node.getAnimations()[0]?.effect;
    if (!(effect instanceof KeyframeEffect)) throw new Error("缺少内容衔接动效");
    return Number.parseFloat(String(effect.getKeyframes()[0]?.translate));
  });
}

test("左右侧栏衔接正文真实位置，首次绘制不闪回且长文不逐帧重排", async (t) => {
  const { app, page, vault, source } = await launch(t);
  try {
    const editor = await page.locator(".ProseMirror").elementHandle();
    const toggle = page.getByRole("button", { name: "显示或隐藏文件栏", exact: true });
    await sampleLayout(page, () => toggle.click());
    await sampleLayout(page, () => toggle.click());
    await sampleLayout(page, () =>
      page.getByRole("button", { name: "工作区助手", exact: true }).click(),
    );
    await sampleLayout(page, () =>
      page.getByRole("button", { name: "关闭助手", exact: true }).click(),
    );
    expect(await editor?.evaluate((node) => node === document.querySelector(".ProseMirror"))).toBe(
      true,
    );
    expect(
      await page.locator(".ProseMirror").evaluate((node) => getComputedStyle(node).scale),
    ).toBe("none");
    expect(await readFile(join(vault, "流动.md"), "utf8")).toBe(source);
  } finally {
    await app.close();
  }
});

test("快速反向接续当前位置，减少动态效果和覆盖式助手立即对齐", async (t) => {
  const { app, page } = await launch(t);
  try {
    const toggle = page.getByRole("button", { name: "显示或隐藏文件栏", exact: true });
    await toggle.click();
    const before = await page.locator(".pane-content").evaluate((node) => {
      const animation = node.getAnimations()[0];
      if (!animation) throw new Error("缺少布局动效");
      animation.pause();
      animation.currentTime = 80;
      return node.querySelector(".document-body")!.getBoundingClientRect().left;
    });
    await toggle.click();
    const after = await page.locator(".pane-content").evaluate((node) => {
      const animation = node.getAnimations()[0];
      if (!animation) throw new Error("缺少反向动效");
      animation.pause();
      animation.currentTime = 0;
      return node.querySelector(".document-body")!.getBoundingClientRect().left;
    });
    expect(after).toBeCloseTo(before, 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.locator(".pane-content").evaluate((node) => node.getAnimations().length),
    ).toBe(0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(900, 720),
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const origin = await page
      .locator(".document-body")
      .evaluate((node) => node.getBoundingClientRect().left);
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    expect(
      await page.locator(".pane-content").evaluate((node) => node.getAnimations().length),
    ).toBe(0);
    expect(
      await page.locator(".document-body").evaluate((node) => node.getBoundingClientRect().left),
    ).toBe(origin);
  } finally {
    await app.close();
  }
});

test("目录与设置按导航方向衔接，关闭设置回到原操作位置", async (t) => {
  const { app, page } = await launch(t);
  try {
    await page.getByRole("button", { name: "文章大纲", exact: true }).click();
    expect(await entryOffset(page, ".outline-content")).toBe(8);
    expect(await page.locator(".library").evaluate((node) => node.getAnimations().length)).toBe(0);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const settings = page.getByRole("button", { name: "设置", exact: true });
    await settings.click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    expect(await entryOffset(page, ".settings-content")).toBe(8);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await page.getByRole("button", { name: "外观与阅读", exact: true }).click();
    expect(await entryOffset(page, ".settings-content")).toBe(-8);
    await page.keyboard.press("Escape");
    expect(await settings.evaluate((node) => document.activeElement === node)).toBe(true);
  } finally {
    await app.close();
  }
});

test("键盘开合侧栏保留正文输入，只有收起焦点所在区域才交还入口", async (t) => {
  const { app, page } = await launch(t);
  try {
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("ControlOrMeta+Backslash");
    expect(await editor.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.type("继续书写");
    expect(await editor.innerText()).toContain("继续书写");
    await page.keyboard.press("ControlOrMeta+Backslash");
    expect(await editor.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.getByRole("searchbox", { name: "搜索笔记库", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Backslash");
    expect(
      await page
        .getByRole("button", { name: "显示或隐藏文件栏", exact: true })
        .evaluate((node) => document.activeElement === node),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
