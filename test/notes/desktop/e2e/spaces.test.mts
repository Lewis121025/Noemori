import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("两个空间：预览、连续写作、自动搜索和跨重启现场", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-spaces-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "我的资料");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state), mkdir(join(vault, "阅读"), { recursive: true })]);
  await writeFile(
    join(vault, "注意力与工具.md"),
    "# 注意力与工具\n\n打开笔记，是为了接着自己的想法写下去。\n\n工具应当记住位置，在需要时提供帮助。\n\n## 留一点空间\n\n先记录，再慢慢整理。\n",
  );
  await writeFile(
    join(vault, "阅读", "渐进呈现.md"),
    "# 渐进呈现\n\n在合适的时候，出现合适的能力。\n",
  );
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({ vaultRoot: vault, currentPath: "注意力与工具.md", filesCollapsed: false }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
    ),
  );
  const launch = () =>
    electron.launch({
      executablePath,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${state}`,
        "--no-sandbox",
      ],
      env,
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    const quickSearch = page.getByRole("searchbox", { name: "快速查找文件", exact: true });
    const quickRows = page.getByRole("tree", { name: "快速打开笔记" }).getByRole("treeitem");
    await quickSearch.press("ArrowDown");
    await expect
      .poll(() => quickRows.first().evaluate((node) => node === document.activeElement))
      .toBe(true);
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => quickRows.nth(1).evaluate((node) => node === document.activeElement))
      .toBe(true);
    expect(await editor.innerText()).toContain("打开笔记，是为了");
    await page.keyboard.press("Escape");
    await expect
      .poll(() => quickSearch.evaluate((node) => node === document.activeElement))
      .toBe(true);
    await quickSearch.fill("注意力");
    await quickSearch.press("Enter");
    await expect
      .poll(() => editor.evaluate((node) => node.contains(document.activeElement)))
      .toBe(true);
    await quickSearch.fill("");
    const original = await editor.elementHandle();
    await editor.locator("p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.type("继续思考。");
    await page.getByRole("button", { name: "资料管理", exact: true }).click();
    const library = page.getByRole("region", { name: "资料管理", exact: true });
    await library.waitFor();
    expect(await readFile(join(vault, "注意力与工具.md"), "utf8")).toContain("继续思考");
    await library.getByRole("treeitem", { name: "阅读", exact: true }).click();
    await library.getByRole("treeitem", { name: "渐进呈现.md", exact: true }).click();
    await expect.poll(() => library.locator(".excerpt").innerText()).toContain("在合适的时候");
    expect(await page.locator(".reading-space").getAttribute("aria-hidden")).toBe("true");
    const artifacts = process.env.NOUS_SPACES_SCREENSHOTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      const bytes = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const [width, height] = win.getContentSize();
        if (width === undefined || height === undefined) throw new Error("窗口尺寸不可用");
        return (await win.capturePage()).resize({ width, height }).toPNG();
      });
      await writeFile(join(artifacts, "nous-library.png"), Buffer.from(bytes));
    }
    await page.getByRole("button", { name: "返回阅读与写作", exact: true }).click();
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await editor.innerText()).toContain("继续思考");
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    await page.getByRole("button", { name: "切换源码视图", exact: true }).click();
    await page.locator(".cm-editor").waitFor();
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    await page.getByRole("button", { name: "切换排版视图", exact: true }).click();
    await editor.waitFor();
    if (artifacts) {
      const bytes = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const [width, height] = win.getContentSize();
        if (width === undefined || height === undefined) throw new Error("窗口尺寸不可用");
        return (await win.capturePage()).resize({ width, height }).toPNG();
      });
      await writeFile(join(artifacts, "nous-writing.png"), Buffer.from(bytes));
    }
    await page.getByRole("button", { name: "资料管理", exact: true }).click();
    expect(
      await library
        .getByRole("treeitem", { name: "渐进呈现.md", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await library.getByRole("button", { name: "打开阅读与写作", exact: true }).click();
    await expect.poll(() => editor.innerText()).toContain("在合适的时候");
    await expect
      .poll(() => editor.evaluate((node) => node.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("可以接着写。");
    await expect.poll(() => editor.innerText()).toContain("可以接着写。");
    await page.getByRole("button", { name: "资料管理", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(640, 480),
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(640);
    const tree = library.getByRole("tree");
    await expect.poll(async () => (await tree.boundingBox())!.height).toBeGreaterThan(70);
    const selected = library.getByRole("treeitem", { name: "渐进呈现.md", exact: true });
    const scroll = await tree.evaluate((node) => node.scrollTop);
    await library.getByRole("button", { name: "预览", exact: true }).click();
    await expect.poll(() => library.locator(".excerpt").innerText()).toContain("在合适的时候");
    expect(await tree.isVisible()).toBe(false);
    await library.getByRole("button", { name: "返回列表", exact: true }).click();
    await tree.waitFor();
    expect(await selected.getAttribute("aria-selected")).toBe("true");
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(scroll);
    await library.getByRole("button", { name: "预览", exact: true }).click();
    await library.getByRole("button", { name: "打开阅读与写作", exact: true }).focus();
    await page.keyboard.press("Escape");
    await tree.waitFor();
    await expect
      .poll(() => selected.evaluate((node) => node === document.activeElement))
      .toBe(true);
    await library.getByRole("button", { name: "预览", exact: true }).click();
    await library.getByRole("button", { name: "重命名", exact: true }).click();
    await library.getByRole("textbox", { name: "重命名文件", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await library.getByRole("searchbox").fill("合适");
    await library
      .getByRole("button", { name: /渐进呈现/ })
      .first()
      .waitFor();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.fileTree.browse
            ?.query,
      )
      .toBe("合适");
    for (const width of [640, 1100]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 720),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const bounds = await library.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.width).toBeLessThanOrEqual(width);
    }
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    await page.getByRole("region", { name: "资料管理", exact: true }).waitFor();
    await expect.poll(() => page.getByRole("searchbox").inputValue()).toBe("合适");
    await page.getByRole("button", { name: "返回阅读与写作", exact: true }).click();
    await expect.poll(() => page.locator(".ProseMirror").innerText()).toContain("在合适的时候");
  } finally {
    await app.close();
  }
});

test("首次记录不要求命名或选目录，实际文件创建在系统文稿目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-first-note-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
    ),
  );
  const app = await electron.launch({
    executablePath,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${join(root, "state")}`,
      "--no-sandbox",
    ],
    env,
  });
  try {
    // 仅测试进程的系统路径指向临时目录，不接触真实用户文稿。
    await app.evaluate(({ app }, path) => app.setPath("documents", path), root);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "开始记录", exact: true }).click();
    await page.locator(".ProseMirror").waitFor();
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("从一个想法开始。");
    await expect
      .poll(async () => readFile(join(root, "Nous", "未命名.md"), "utf8"), { timeout: 5000 })
      .toContain("从一个想法开始");
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.getByRole("button", { name: "新建笔记", exact: true }).click();
    await expect.poll(async () => readFile(join(root, "Nous", "未命名 2.md"), "utf8")).toBe("");
  } finally {
    await app.close();
  }
});
