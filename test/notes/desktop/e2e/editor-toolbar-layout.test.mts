import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron, type Page } from "playwright-core";
import { documentTools, openSplit, noteAction } from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

async function checkToolbar(page: Page, label: string): Promise<void> {
  const pane = page.locator(".pane-column.active");
  await documentTools(page);
  const toolbar = page
    .locator(".topbar-document:not([hidden])")
    .getByRole("toolbar", { name: label, exact: true });
  await toolbar.waitFor();
  await toolbar.scrollIntoViewIfNeeded();
  const before = (await toolbar.boundingBox())!;
  const header = (await page.locator(".window-toolbar").boundingBox())!;
  expect(before.y).toBeGreaterThanOrEqual(header.y);
  expect(before.y + before.height).toBeLessThanOrEqual(header.y + header.height);
  await pane.locator(".main").evaluate((node) => {
    node.scrollTop = 600;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const after = (await toolbar.boundingBox())!;
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.x).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await toolbar.locator("button:not(:disabled), select:not(:disabled)").all()) {
    await control.focus();
    const box = await control.boundingBox();
    const port = (await page.locator(".window-document-tools").boundingBox())!;
    if (box === null) continue;
    expect(box.x).toBeGreaterThanOrEqual(port.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(port.x + port.width + 1);
  }

}

test("编辑工具常驻顶栏，滚动与窄屏分栏保留工具和正文独立布局", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-toolbar-layout-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source =
    "# 长文\n\n" +
    Array.from(
      { length: 60 },
      (_, index) => `## 第${index}节\n\n这是正文第${index}段，用来验证工具栏和正文不会重叠。\n\n`,
    ).join("");
  await writeFile(join(vault, "长文.md"), source);
  await writeFile(join(vault, "对照.md"), source);
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      vaultRoot: vault,
      currentPath: "长文.md",
      mode: "editing",
      filesCollapsed: true,
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
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".ProseMirror").waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    await checkToolbar(page, "编辑工具栏");
    const heading = page.locator(".ProseMirror h2").filter({ hasText: /^第20节$/ });
    await heading.evaluate((node) => node.scrollIntoView({ block: "start" }));
    const bar = page.getByRole("toolbar", { name: "编辑工具栏", exact: true });
    const barBox = (await bar.boundingBox())!;
    const headingBox = (await heading.boundingBox())!;
    expect(headingBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
    expect(
      await heading.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + 10, box.y + box.height / 2));
      }),
    ).toBe(true);
    await noteAction(page, "切换源码视图");
    await checkToolbar(page, "文本编辑工具栏");
    await noteAction(page, "切换排版视图");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(640, 640),
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(640);
    await checkToolbar(page, "编辑工具栏");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 720),
    );
    await openSplit(page);
    const picker = page.locator("dialog.picker[open]").getByRole("combobox");
    await picker.fill("对照");
    await picker.press("Enter");
    await expect.poll(() => page.locator(".ProseMirror").count()).toBe(2);
    for (const width of [650, 1100]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 720),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      for (const button of await page.locator(".pane-switch button").all()) {
        await button.click();
        await checkToolbar(page, "编辑工具栏");
      }
    }
    const screenshots = process.env.NOEMORI_TOOLBAR_SCREENSHOTS;
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      const bytes = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const [width, height] = win.getContentSize();
        if (width === undefined || height === undefined) throw new Error("窗口尺寸不可用");
        return (await win.capturePage()).resize({ width, height }).toPNG();
      });
      await writeFile(join(screenshots, "toolbar-layout.png"), Buffer.from(bytes));
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
