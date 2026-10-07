import { confirmNewEntry } from "../support/workspace-actions";
import { noteAction, openLibrary, sidebarComponent } from "../support/workspace-actions";
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
    const editor = page.locator(".reading-space .ProseMirror");
    await editor.waitFor();
    const original = await editor.elementHandle();
    await editor.locator("p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.type("继续思考。");
    await openLibrary(page);
    const library = page.getByRole("region", { name: "文件系统", exact: true });
    await library.waitFor();
    expect(await readFile(join(vault, "注意力与工具.md"), "utf8")).toContain("继续思考");
    await library.locator('[data-path="阅读"]').dblclick();
    await library.locator('[data-path="阅读/渐进呈现.md"]').click();
    await expect.poll(() => library.locator(".library-document").innerText()).toContain("在合适的时候");
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
    await page.getByRole("button", { name: "目录", exact: true }).click();
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await editor.innerText()).toContain("继续思考");
    await noteAction(page, "切换源码视图");
    await page.locator(".cm-editor").waitFor();
    await noteAction(page, "切换排版视图");
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
    await openLibrary(page);
    expect(
      await library.locator('[data-path="阅读/渐进呈现.md"]').locator('xpath=ancestor::*[@role="gridcell"]').getAttribute("aria-selected"),
    ).toBe("true");
    await library.getByRole("button", { name: "打开阅读与写作", exact: true }).click();
    await expect.poll(() => editor.innerText()).toContain("在合适的时候");
    await expect
      .poll(() => editor.evaluate((node) => node.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("可以接着写。");
    await expect.poll(() => editor.innerText()).toContain("可以接着写。");
    await openLibrary(page);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(640, 480),
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(640);
    if (await page.getByRole("complementary", { name: "文件栏", exact: true }).isVisible())
      await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    const tree = library.getByRole("treegrid");
    await expect.poll(async () => (await tree.boundingBox())!.height).toBeGreaterThan(70);
    const selected = library.locator('[data-path="阅读/渐进呈现.md"]');
    const scroll = await tree.evaluate((node) => node.scrollTop);
    await library.getByRole("button", { name: "预览", exact: true }).click();
    await expect.poll(() => library.locator(".library-document").innerText()).toContain("在合适的时候");
    expect(await tree.isVisible()).toBe(false);
    await library.getByRole("button", { name: "返回列表", exact: true }).click();
    await tree.waitFor();
    expect(await selected.locator('xpath=ancestor::*[@role="gridcell"]').getAttribute("aria-selected")).toBe("true");
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(scroll);
    await library.getByRole("button", { name: "预览", exact: true }).click();
    await library.getByRole("button", { name: "打开阅读与写作", exact: true }).focus();
    await page.keyboard.press("Escape");
    await tree.waitFor();
    await expect
      .poll(() => selected.evaluate((node) => node === document.activeElement))
      .toBe(true);
    await library.getByRole("button", { name: "预览", exact: true }).click();
    await library.getByRole("button", { name: "返回列表", exact: true }).click();
    await selected.press("F2");
    await library.getByRole("textbox", { name: "重命名文件", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await library.getByRole("searchbox").fill("渐进");
    await library.locator('[data-path="阅读/渐进呈现.md"]').first().waitFor();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.fileTree.browse
            ?.query,
      )
      .toBe("渐进");
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
    await page.getByRole("region", { name: "文件系统", exact: true }).waitFor();
    await expect
      .poll(() =>
        page
          .getByRole("region", { name: "文件系统", exact: true })
          .getByRole("searchbox")
          .inputValue(),
      )
      .toBe("渐进");
    await sidebarComponent(page, "目录");
    await expect.poll(() => page.locator(".reading-space .ProseMirror").innerText()).toContain("在合适的时候");
  } finally {
    await app.close();
  }
});

test("首次记录先选笔记库并确认名称位置，再连续创建笔记", async (t) => {
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
    await mkdir(join(root, "Noemori"));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, join(root, "Noemori"));
    const page = await app.firstWindow();
    await page.getByRole("region", { name: "打开资料库", exact: true }).waitFor({ state: "hidden" });
    await page.locator(".content-space").click();
    await page.keyboard.press("ControlOrMeta+n");
    await confirmNewEntry(page);
    await page.locator(".ProseMirror").waitFor();
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("从一个想法开始。");
    await expect
      .poll(async () => readFile(join(root, "Noemori", "未命名.md"), "utf8"), { timeout: 5000 })
      .toContain("从一个想法开始");
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await page.keyboard.press("ControlOrMeta+n");
    await confirmNewEntry(page);
    await expect.poll(async () => readFile(join(root, "Noemori", "未命名 2.md"), "utf8")).toBe("");
  } finally {
    await app.close();
  }
});

test("层级目录折叠与展开保持滚动，打开文件后可返回原浏览位置", async (t) => {
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
    await openLibrary(page);
    const tree = page.getByRole("treegrid", { name: "文件系统" });
    const row = (path: string) => tree.locator(`[data-path="${path}"]`);
    const project = row("项目");
    const initialY = (await project.boundingBox())!.y;
    for (let attempt = 0; attempt < 3; attempt++) {
      await project.press("ArrowRight");
      await expect.poll(() => project.locator('xpath=ancestor::*[@role="row"]').getAttribute("aria-expanded")).toBe("true");
      expect((await project.boundingBox())!.y).toBeCloseTo(initialY, 0);
      await project.press("ArrowLeft");
      await expect.poll(() => project.locator('xpath=ancestor::*[@role="row"]').getAttribute("aria-expanded")).toBe("false");
      expect((await project.boundingBox())!.y).toBeCloseTo(initialY, 0);
    }
    await project.press("ArrowRight");
    await tree.evaluate((node) => { node.scrollTop = 280; });
    const directory = row("项目/目录15");
    await directory.waitFor();
    const beforeY = (await directory.boundingBox())!.y;
    await directory.click();
    await page.locator('.library [data-path="项目/目录15/笔记0.md"]').waitFor();
    expect((await directory.boundingBox())!.y).toBeCloseTo(beforeY, 0);
    await page.locator('.library [data-path="项目/目录15/笔记0.md"]').dblclick();
    await expect.poll(() => page.locator(".reading-space .ProseMirror").innerText()).toContain("目录15的内容");
    await page.locator(".reading-space").waitFor();
    await openLibrary(page);
    expect((await directory.boundingBox())!.y).toBeCloseTo(beforeY, 0);
    expect(await page.locator('.library [data-path="项目/目录15/笔记0.md"]').isVisible()).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(640, 480));
    await page.waitForFunction(() => innerWidth === 640);
    if ((await page.locator(".file-sidebar").getAttribute("hidden")) !== null)
      await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    await tree.evaluate((node) => { node.scrollTop = 0; });
    await project.click();
    expect(await tree.isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
