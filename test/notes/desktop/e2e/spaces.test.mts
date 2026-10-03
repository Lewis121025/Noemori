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
  const root = await mkdtemp(join(tmpdir(), "noemori-spaces-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "我的资料");
  const state = join(root, "state");
  await Promise.all([mkdir(state), mkdir(join(vault, "阅读"), { recursive: true })]);
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
    const quickRows = page.getByRole("tree", { name: "当前笔记库文件树" }).getByRole("treeitem");
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
    const directory = quickRows.filter({ hasText: "阅读" });
    await directory.click();
    expect(await directory.getAttribute("aria-expanded")).toBe("true");
    expect(await editor.innerText()).toContain("打开笔记，是为了");
    const nestedNote = quickRows.filter({ hasText: "渐进呈现.md" });
    expect(await nestedNote.getAttribute("aria-level")).toBe("2");
    await nestedNote.click();
    await expect.poll(() => editor.innerText()).toContain("在合适的时候");
    expect(await nestedNote.getAttribute("aria-current")).toBe("page");
    await quickRows.filter({ hasText: "注意力与工具.md" }).click();
    await expect.poll(() => editor.innerText()).toContain("打开笔记，是为了");
    await quickSearch.fill("注意力");
    await quickSearch.press("Enter");
    await expect
      .poll(() => editor.evaluate((node) => node.contains(document.activeElement)))
      .toBe(true);
    await quickSearch.fill("");
    const trashNote = page.getByRole("button", {
      name: "将 注意力与工具.md 移到废纸篓",
      exact: true,
    });
    await quickRows.filter({ hasText: "注意力与工具.md" }).hover();
    await trashNote.click();
    const trash = page.getByRole("dialog", { name: "移到废纸篓", exact: true });
    expect(await trash.innerText()).toContain("将“注意力与工具.md”移到系统废纸篓");
    await trash.getByRole("button", { name: "取消", exact: true }).click();
    await expect
      .poll(() => trashNote.evaluate((node) => node === document.activeElement))
      .toBe(true);
    await directory.focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Backspace" : "Delete");
    await trash.waitFor();
    expect(await trash.innerText()).toContain("其中的所有文件会一起移动");
    await page.keyboard.press("Escape");
    await expect
      .poll(() => directory.evaluate((node) => node === document.activeElement))
      .toBe(true);
    expect(await readFile(join(vault, "阅读", "渐进呈现.md"), "utf8")).toContain("在合适的时候");
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
    const artifacts = process.env.NOEMORI_SPACES_SCREENSHOTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      const bytes = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const [width, height] = win.getContentSize();
        if (width === undefined || height === undefined) throw new Error("窗口尺寸不可用");
        return (await win.capturePage()).resize({ width, height }).toPNG();
      });
      await writeFile(join(artifacts, "noemori-library.png"), Buffer.from(bytes));
    }
    await page.getByRole("button", { name: "阅读与写作", exact: true }).click();
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
      await writeFile(join(artifacts, "noemori-writing.png"), Buffer.from(bytes));
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
    await page.getByRole("button", { name: "阅读与写作", exact: true }).click();
    await expect.poll(() => page.locator(".ProseMirror").innerText()).toContain("在合适的时候");
  } finally {
    await app.close();
  }
});

test("首次记录不要求命名或选目录，实际文件创建在系统文稿目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-first-note-"));
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
      .poll(async () => readFile(join(root, "Noemori", "未命名.md"), "utf8"), { timeout: 5000 })
      .toContain("从一个想法开始");
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.getByRole("button", { name: "新建笔记", exact: true }).click();
    await expect.poll(async () => readFile(join(root, "Noemori", "未命名 2.md"), "utf8")).toBe("");
  } finally {
    await app.close();
  }
});

test("笔记侧栏展开折叠和打开可见文件时保持操作位置", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-sidebar-position-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await mkdir(state);
  await Promise.all(
    Array.from({ length: 30 }, async (_, index) => {
      const folder = join(vault, "项目", `目录${index}`);
      await mkdir(folder, { recursive: true });
      await Promise.all(
        Array.from({ length: 15 }, (_, note) =>
          writeFile(join(folder, `笔记${note}.md`), `# 笔记${note}\n\n目录${index}的内容。\n`),
        ),
      );
    }),
  );
  await writeFile(join(vault, "当前.md"), "# 当前笔记\n\n保持阅读位置。\n");
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      vaultRoot: vault,
      currentPath: "当前.md",
      filesCollapsed: false,
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
    await page.locator(".ProseMirror").waitFor();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const tree = page.getByRole("tree", { name: "当前笔记库文件树" });
    const row = (path: string) => tree.locator(`[data-path="${path}"]`);
    const project = row("项目");
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    await settle();
    const initialY = (await project.boundingBox())!.y;
    for (let attempt = 0; attempt < 3; attempt++) {
      await project.click();
      await settle();
      expect(await project.getAttribute("aria-expanded")).toBe("true");
      expect(await tree.evaluate((node) => node.scrollTop)).toBe(0);
      expect((await project.boundingBox())!.y).toBeCloseTo(initialY, 0);
      await project.press("ArrowLeft");
      await settle();
      expect(await project.getAttribute("aria-expanded")).toBe("false");
      expect((await project.boundingBox())!.y).toBeCloseTo(initialY, 0);
    }
    await project.click();
    await tree.evaluate((node) => {
      node.scrollTop = 352;
    });
    await settle();
    const directory = row("项目/目录15");
    const beforeY = (await directory.boundingBox())!.y;
    const beforeScroll = await tree.evaluate((node) => node.scrollTop);
    for (let attempt = 0; attempt < 3; attempt++) {
      await directory.click();
      await settle();
      expect((await directory.boundingBox())!.y).toBeCloseTo(beforeY, 0);
      expect(await tree.evaluate((node) => node.scrollTop)).toBe(beforeScroll);
      await directory.press("ArrowLeft");
      await settle();
      expect((await directory.boundingBox())!.y).toBeCloseTo(beforeY, 0);
      expect(await tree.evaluate((node) => node.scrollTop)).toBe(beforeScroll);
    }
    await directory.click();
    const note = row("项目/目录15/笔记0.md");
    const noteY = (await note.boundingBox())!.y;
    await note.click();
    await expect.poll(() => page.locator(".ProseMirror").innerText()).toContain("目录15的内容");
    await settle();
    expect((await note.boundingBox())!.y).toBeCloseTo(noteY, 0);
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(beforeScroll);
    expect(await page.locator(".quick-navigation .library-link").count()).toBe(0);
    expect(
      await tree
        .getByRole("button", { name: "将 项目/目录15/笔记0.md 移到废纸篓", exact: true })
        .count(),
    ).toBe(1);
    const artifacts = process.env.NOEMORI_SPACES_SCREENSHOTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      const bytes = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const [width, height] = win.getContentSize();
        if (width === undefined || height === undefined) throw new Error("窗口尺寸不可用");
        return (await win.capturePage()).resize({ width, height }).toPNG();
      });
      await writeFile(join(artifacts, "sidebar-stable-position.png"), Buffer.from(bytes));
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(640, 480),
    );
    await tree.waitFor();
    await tree.evaluate((node) => {
      node.scrollTop = 0;
    });
    await settle();
    const compactY = (await project.boundingBox())!.y;
    await project.click();
    await settle();
    expect((await project.boundingBox())!.y).toBeCloseTo(compactY, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
