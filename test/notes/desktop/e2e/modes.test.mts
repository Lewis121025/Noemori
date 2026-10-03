import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { noteAction } from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("应用模式跨文件和重启保持一致，阅读保留正文、待办、高亮与文件操作", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-modes-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  await writeFile(join(vault, "a.md"), "# 模式测试\n\n- [ ] 待办\n\n可修改的正文\n");
  await writeFile(join(vault, "b.md"), "# 第二篇\n\n另一篇正文\n");
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      vaultRoot: vault,
      currentPath: "a.md",
      filesCollapsed: false,
      mode: "editing",
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
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    const toolbar = page.getByRole("toolbar", { name: "编辑工具栏", exact: true });
    await toolbar.waitFor();
    expect(await toolbar.getByRole("button", { name: "插入表格", exact: true }).isVisible()).toBe(
      true,
    );
    const screenshots = process.env.NOEMORI_MODE_SCREENSHOTS;
    const capture = async (name: string) => {
      if (!screenshots) return;
      await mkdir(screenshots, { recursive: true });
      const bytes = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const [width, height] = win.getContentSize();
        if (width === undefined || height === undefined) throw new Error("窗口尺寸不可用");
        return (await win.capturePage()).resize({ width, height }).toPNG();
      });
      await writeFile(join(screenshots, name), Buffer.from(bytes));
    };
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    await capture("editing.png");
    await page.getByRole("button", { name: "切换阅读模式", exact: true }).click();
    await expect.poll(() => toolbar.count()).toBe(0);
    expect(await editor.getAttribute("contenteditable")).toBe("true");
    await editor.getByRole("checkbox", { name: "标记任务完成" }).click();
    const paragraph = editor.locator(":scope > p").last();
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("，阅读时补充。");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    const selection = page.getByRole("toolbar", { name: "选区格式", exact: true });
    await selection.getByRole("button", { name: "高亮", exact: true }).click();
    expect(await selection.getByRole("button", { name: "加粗", exact: true }).count()).toBe(0);
    await page.keyboard.press("ControlOrMeta+b");
    expect(await editor.locator("strong").count()).toBe(0);
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => readFile(join(vault, "a.md"), "utf8")).toContain("- [x] 待办");
    await expect
      .poll(() => readFile(join(vault, "a.md"), "utf8"))
      .toContain("==可修改的正文，阅读时补充。==");
    await page.keyboard.press("Escape");
    await capture("reading.png");
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    expect(await page.getByRole("button", { name: "切换源码视图", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "重命名…", exact: true }).click();
    await page.getByRole("textbox", { name: "文件名", exact: true }).fill("renamed.md");
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    await expect.poll(() => page.locator(".document-name").innerText()).toBe("renamed.md");
    await page
      .getByRole("tree", { name: "当前笔记库文件树" })
      .getByRole("treeitem", { name: "b.md", exact: true })
      .click();
    await expect.poll(() => editor.innerText()).toContain("另一篇正文");
    expect(await toolbar.count()).toBe(0);
    await page.getByRole("button", { name: "新建笔记", exact: true }).click();
    await expect.poll(() => readFile(join(vault, "未命名.md"), "utf8")).toBe("");
    expect(await toolbar.count()).toBe(0);
    await expect
      .poll(async () => JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.mode)
      .toBe("reading");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    await page.getByRole("button", { name: "切换编辑模式", exact: true }).waitFor();
    expect(await page.getByRole("toolbar", { name: "编辑工具栏", exact: true }).count()).toBe(0);
    await page
      .getByRole("tree", { name: "当前笔记库文件树" })
      .getByRole("treeitem", { name: "renamed.md", exact: true })
      .click();
    await page.getByRole("button", { name: "切换编辑模式", exact: true }).click();
    await page.getByRole("toolbar", { name: "编辑工具栏", exact: true }).waitFor();
    await noteAction(page, "切换源码视图");
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\n源码补充。\n");
    await page.getByRole("button", { name: "切换阅读模式", exact: true }).click();
    await expect.poll(() => page.locator(".ProseMirror").innerText()).toContain("源码补充");
    await page.locator(".ProseMirror > p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("阅读继续。");
    await page.getByRole("button", { name: "切换编辑模式", exact: true }).click();
    await expect.poll(() => page.locator(".cm-content").textContent()).toContain("阅读继续");
    await noteAction(page, "切换排版视图");
    for (const width of [640, 1100]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 720),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      if (width === 640)
        await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
      const bar = page.getByRole("toolbar", { name: "编辑工具栏", exact: true });
      const box = (await bar.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
