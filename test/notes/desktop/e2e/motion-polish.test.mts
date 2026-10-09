import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test, type TestContext } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

async function launch(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "noemori-polish-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  await Promise.all([
    writeFile(
      join(vault, "森林.md"),
      "# 森林\n\n" + Array.from({ length: 80 }, (_, i) => `## 章节 ${i}\n\n正文。\n`).join("\n"),
    ),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ appearance: "light", reader: { vaultRoot: vault, currentPath: "森林.md" } }),
    ),
    ...Array.from({ length: 35 }, (_, i) =>
      writeFile(join(vault, `笔记${String(i).padStart(2, "0")}.md`), `# 笔记 ${i}\n`),
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
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
        ),
      ),
      NOEMORI_TEST_WINDOW: "hidden",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.onTestFinished(() => {
    expect(errors).toEqual([]);
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".ProseMirror").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { app, page };
}

test("设置分类从各自位置进入，切回后保留该分类的阅读位置", async (t) => {
  const { app, page } = await launch(t);
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const legend = page.locator(".appearance-options legend");
    const origin = await legend.evaluate((element) => element.getBoundingClientRect().top);
    await page.locator(".settings-content").hover();
    await page.mouse.wheel(0, 160);
    await expect
      .poll(() => legend.evaluate((element) => element.getBoundingClientRect().top))
      .toBeLessThan(origin - 50);
    const saved = await legend.evaluate((element) => element.getBoundingClientRect().top);
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const top = await page
      .locator(".settings-content")
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(
      await page
        .getByRole("heading", { name: "常用快捷键", exact: true })
        .evaluate((element) => element.getBoundingClientRect().top),
    ).toBeGreaterThanOrEqual(top);
    await page.getByRole("button", { name: "外观与阅读", exact: true }).click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    expect(await legend.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
      saved,
      0,
    );
  } finally {
    await app.close();
  }
});

test("临时弹窗退出保留尾帧但立即交还焦点，连续重开仍能输入和执行命令", async (t) => {
  const { app, page } = await launch(t);
  try {
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("ControlOrMeta+o");
    const picker = page.locator(".picker");
    await picker.waitFor();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const original = await picker.elementHandle();
    await picker.getByRole("combobox").fill("笔记02");
    await page.keyboard.press("Escape");
    expect(
      await original?.evaluate((element) => {
        if (!(element instanceof HTMLDialogElement)) throw new Error("缺少选择弹窗");
        return { connected: element.isConnected, open: element.open, inert: element.inert };
      }),
    ).toEqual({ connected: true, open: false, inert: true });
    expect(
      await page
        .locator(".ProseMirror")
        .evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("ControlOrMeta+o");
    expect(await page.locator(".picker[open]").getByRole("combobox").inputValue()).toBe("");
    await page.locator(".picker[open]").getByRole("combobox").fill("笔记01");
    expect(await page.locator(".picker[open]").getByRole("combobox").inputValue()).toBe("笔记01");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".picker") === null);
    await page.keyboard.press("ControlOrMeta+p");
    await page.locator(".picker[open]").getByRole("combobox").fill("设置");
    await page.keyboard.press("Enter");
    await page.locator(".settings-window[open]").waitFor();
    expect(await page.locator("dialog[open]").count()).toBe(1);
  } finally {
    await app.close();
  }
});

test("编辑弹窗快速重开不残留旧输入，退出动画不干扰正文编辑与撤销", async (t) => {
  const { app, page } = await launch(t);
  try {
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    // 后台窗口的原生 selectionchange 延后派发，等待编辑器完成该轮选区同步。
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("森林");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page
      .locator("dialog[open]")
      .filter({ has: page.getByRole("heading", { name: "插入链接", exact: true }) });
    const selectedText = await dialog
      .getByRole("textbox", { name: "显示文字", exact: true })
      .inputValue();
    expect(selectedText).toBe("森林");
    await dialog.getByRole("combobox", { name: "链接目标", exact: true }).fill("尚未提交");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+k");
    expect(await dialog.getByRole("combobox", { name: "链接目标", exact: true }).inputValue()).toBe(
      "",
    );
    await page.waitForTimeout(200);
    expect(await dialog.getByRole("textbox", { name: "显示文字", exact: true }).inputValue()).toBe(
      selectedText,
    );
    await dialog.getByRole("combobox", { name: "链接类型", exact: true }).selectOption("md");
    await dialog
      .getByRole("combobox", { name: "链接目标", exact: true })
      .fill("https://example.com");
    await dialog.getByRole("button", { name: "插入", exact: true }).click();
    await page.locator('.ProseMirror a[href="https://example.com/"]').waitFor();
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(() => page.locator('.ProseMirror a[href="https://example.com/"]').count())
      .toBe(0);
    expect(
      await page
        .locator(".ProseMirror")
        .evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("键盘候选筛选后第一项可见，中途减少动态效果会完成目录折叠", async (t) => {
  const { app, page } = await launch(t);
  try {
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("ControlOrMeta+o");
    const input = page.locator(".picker[open]").getByRole("combobox");
    await input.fill("笔记");
    for (let index = 0; index < 25; index += 1) await page.keyboard.press("ArrowDown");
    expect(
      await page.locator(".picker .results").evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(100);
    await input.fill("笔");
    await expect
      .poll(() => page.locator(".picker .results").evaluate((element) => element.scrollTop))
      .toBe(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "文章大纲", exact: true }).click();
    const kids = page.locator(".outline-sidebar nav > .kids");
    expect(
      await page
        .locator(".outline-sidebar .twist")
        .first()
        .evaluate(
          (element) =>
            element.getBoundingClientRect().height -
            element.parentElement!.getBoundingClientRect().height,
        ),
    ).toBeCloseTo(0, 1);
    await page
      .locator(".outline-sidebar")
      .getByRole("button", { name: "折叠", exact: true })
      .first()
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".outline-sidebar nav > .kids")
        ?.getAnimations()
        .some((animation) => Number(animation.effect?.getTiming().duration) > 0),
    );
    await kids.evaluate((element) =>
      element.getAnimations().forEach((animation) => animation.pause()),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => kids.count()).toBe(0);
  } finally {
    await app.close();
  }
});
