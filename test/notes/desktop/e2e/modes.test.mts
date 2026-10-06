import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import {
  noteAction,
  openSettings,
  openSplit,
  sidebarComponent,
} from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("统一读写：窗口按钮、独立设置与底部双链各有唯一职责，旧会话恢复后可直接编辑", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-unified-workspace-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  await writeFile(join(vault, "甲.md"), "# 甲文档\n\n可以直接编辑的正文。\n\n[[乙]]\n");
  await writeFile(join(vault, "乙.md"), "# 乙文档\n\n这篇笔记引用 [[甲]]，用于检查双链。\n");
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      reader: {
        vaultRoot: vault,
        currentPath: "甲.md",
        filesCollapsed: false,
        mode: "reading",
        viewModes: { "甲.md": "reading" },
      },
    }),
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
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 760),
    );
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    expect(await page.locator(".mode-switch, .caption, .sidebar-reopen").count()).toBe(0);
    expect(await editor.getAttribute("contenteditable")).toBe("true");
    const toggle = page.getByRole("button", { name: "显示或隐藏文件栏", exact: true });
    expect(await toggle.count()).toBe(1);
    const toggleBox = (await toggle.boundingBox())!;
    expect(toggleBox.y).toBeLessThan(44);
    expect(toggleBox.x).toBeLessThan(150);
    const split = page.getByRole("button", { name: "在另一栏打开…", exact: true });
    expect(await split.count()).toBe(1);
    expect((await split.boundingBox())!.x).toBeGreaterThan(1000);
    await toggle.click();
    await page.locator(".file-sidebar").waitFor({ state: "hidden" });
    expect(await toggle.isVisible()).toBe(true);
    await toggle.click();

    const paragraph = editor.locator("p").filter({ hasText: /^可以直接编辑的正文。/ });
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("补充");
    await paragraph.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
      "可以直接编辑的正文。补充",
    );
    await page.keyboard.press("Alt+F10");
    const tools = page.getByRole("toolbar", { name: "编辑工具栏", exact: true });
    await tools.waitFor();
    expect(await tools.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    expect(await page.getByRole("button", { name: "高亮", exact: true }).count()).toBe(1);
    await tools.getByRole("button", { name: "高亮", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "甲.md"), "utf8"))
      .toContain("==可以直接编辑的正文。补充==");
    await noteAction(page, "切换源码视图");
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\n源码补充。\n");
    await noteAction(page, "切换排版视图");
    await expect.poll(() => editor.innerText()).toContain("源码补充");

    await openSettings(page);
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    expect(await page.locator(".file-sidebar .settings-window").count()).toBe(0);
    await settings.getByRole("button", { name: "深色", exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("dark");
    await settings.getByRole("button", { name: "浅色", exact: true }).click();
    await settings.getByRole("button", { name: "笔记库", exact: true }).click();
    expect(await settings.getByRole("region", { name: "笔记库设置" }).innerText()).toContain(vault);
    await settings.getByRole("button", { name: "快捷键", exact: true }).click();
    expect(await settings.getByRole("region", { name: "快捷键说明" }).innerText()).not.toContain(
      "切换阅读",
    );
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });
    await page.keyboard.press("ControlOrMeta+,");
    await settings.waitFor();
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();

    await openSplit(page);
    const picker = page.locator("dialog.picker[open]").getByRole("combobox");
    await picker.fill("乙");
    await picker.press("Enter");
    await expect.poll(() => page.locator(".pane-column").count()).toBe(2);
    expect(await page.locator(".file-sidebar .pane-switch").count()).toBe(0);
    await page.getByRole("button", { name: "关闭双栏", exact: true }).click();
    await expect.poll(() => page.locator(".pane-column").count()).toBe(1);
    expect(await editor.innerText()).toContain("乙文档");
    await sidebarComponent(page, "文件");
    await page.getByRole("treeitem", { name: "甲.md", exact: true }).click();
    await expect.poll(() => editor.innerText()).toContain("甲文档");
    const links = page.getByRole("button", { name: "双链", exact: true });
    expect(await links.getAttribute("aria-expanded")).toBe("false");
    await links.click();
    const dock = page.getByRole("region", { name: "双链面板", exact: true });
    await expect.poll(() => dock.locator(".references").innerText()).toContain("乙");
    expect(await dock.locator("details").count()).toBe(0);
    const dockBox = (await page.locator(".links-dock").boundingBox())!;
    const sideBox = (await page.locator(".file-sidebar").boundingBox())!;
    expect(dockBox.y + dockBox.height).toBeCloseTo(sideBox.y + sideBox.height, 0);
    expect(
      await dock
        .locator(".hit")
        .first()
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
    ).toBeGreaterThanOrEqual(12);
    const screenshotDir = process.env.NOEMORI_UNIFIED_SCREENSHOTS;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, "workspace.png"), animations: "disabled" });
      await openSettings(page);
      await settings.getByRole("button", { name: "外观与阅读", exact: true }).click();
      await page.screenshot({ path: join(screenshotDir, "settings.png"), animations: "disabled" });
      await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    }
    await dock.locator(".hit").first().click();
    await expect.poll(() => editor.innerText()).toContain("乙文档");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(async () => JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.mode)
      .toBeUndefined();
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".ProseMirror").waitFor();
    expect(await page.locator(".mode-switch").count()).toBe(0);
    expect(await page.locator(".ProseMirror").getAttribute("contenteditable")).toBe("true");
    expect(
      await page.getByRole("button", { name: "双链", exact: true }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
