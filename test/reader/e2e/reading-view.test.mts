import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("跨视图与重启：长文选区和双栏阅读锚点在前文变化、窗口改宽后仍连续", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-reading-resume-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const source =
    "\uFEFF# 连续阅读\r\n\r\n" +
    Array.from(
      { length: 120 },
      (_, index) =>
        `第${String(index).padStart(3, "0")}段 定位文字 🌱。${"阅读与写作应当连续而安静。".repeat(10)}`,
    ).join("\r\n\r\n") +
    "\r\n";
  const sessionFile = join(userData, "session.json");
  await Promise.all([
    writeFile(join(vault, "长文.md"), source),
    writeFile(join(vault, "对照.md"), source),
    writeFile(
      sessionFile,
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          filesCollapsed: true,
          documents: {
            panes: ["长文.md", "对照.md"].map((path) => ({
              currentPath: path,
              history: { back: [], forward: [] },
            })),
            active: 0,
            split: true,
          },
          viewModes: { "长文.md": "reading", "对照.md": "reading" },
        },
        window: { width: 1300, height: 760 },
      }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  const launch = () =>
    electron.launch({
      executablePath: executable,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${userData}`,
        "--no-sandbox",
      ],
      env: environment,
    });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ready = () =>
      page.waitForFunction(
        () =>
          document.querySelectorAll(
            "section[data-pane] .ProseMirror, section[data-pane] .cm-content",
          ).length === 2 &&
          Array.from(document.querySelectorAll("section[data-pane]")).every(
            (pane) => !pane.hasAttribute("inert"),
          ),
      );
    await ready();
    const left = page.locator('section[data-pane="0"]');
    const right = page.locator('section[data-pane="1"]');
    const paragraph = left.locator(".ProseMirror > p").filter({ hasText: "第064段" });
    await paragraph.evaluate((element) => {
      element.scrollIntoView({ block: "start" });
      const editor = element.closest<HTMLElement>(".ProseMirror");
      editor?.focus({ preventScroll: true });
      const text = element.firstChild;
      if (text === null) throw new Error("缺少段落文字");
      const start = text.textContent!.indexOf("定位文字");
      document.getSelection()?.setBaseAndExtent(text, start + 4, text, start);
    });
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe("定位文字");
    const offset = () =>
      paragraph.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest(".main")!.getBoundingClientRect().top,
      );
    const before = await offset();
    await page.keyboard.press("ControlOrMeta+e");
    await left.locator(".cm-content").waitFor();
    await ready();
    const codeLine = left.locator(".cm-line").filter({ hasText: "第064段" });
    await expect.poll(() => codeLine.count()).toBe(1);
    const codeOffset = () =>
      codeLine.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest(".main")!.getBoundingClientRect().top,
      );
    await expect.poll(async () => Math.abs((await codeOffset()) - before)).toBeLessThan(24);
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe("定位文字");
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await paragraph.waitFor();
    await ready();
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(24);
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe("定位文字");

    // 同一轮恢复覆盖源码和阅读两种表面；两个分栏停在不同段落。
    await page.keyboard.press("ControlOrMeta+e");
    await left.locator(".cm-content").waitFor();
    await ready();
    const other = right.locator(".ProseMirror > p").filter({ hasText: "第088段" });
    await other.evaluate((element) => element.scrollIntoView({ block: "start" }));
    const leftBeforeClose = await codeOffset();
    const rightBeforeClose = await other.evaluate(
      (element) =>
        element.getBoundingClientRect().top - element.closest(".main")!.getBoundingClientRect().top,
    );
    expect(errors).toEqual([]);
    // 立即关窗也要保存，不能依赖 scrollend 已经发生。
    await app.close();
    const saved = JSON.parse(await readFile(sessionFile, "utf8"));
    for (const pane of saved.reader.documents.panes) {
      expect(pane.position, JSON.stringify(saved.reader.documents)).toBeDefined();
      expect(pane.position?.source.offset, JSON.stringify(saved.reader.documents)).toBeGreaterThan(
        1000,
      );
    }
    expect(await readFile(join(vault, "长文.md"), "utf8")).toBe(source);
    saved.window = { ...saved.window, width: 1060, height: 700 };
    const changed = "\uFEFF新增的前言。\r\n\r\n" + source.slice(1);
    await Promise.all([
      writeFile(sessionFile, JSON.stringify(saved)),
      writeFile(join(vault, "长文.md"), changed),
      writeFile(join(vault, "对照.md"), changed),
    ]);
    app = await launch();
    const reopened = await app.firstWindow();
    reopened.on("pageerror", (error) => errors.push(error.message));
    await reopened.waitForFunction(
      () =>
        document.querySelectorAll("section[data-pane]").length === 2 &&
        Array.from(document.querySelectorAll("section[data-pane]")).every(
          (pane) => !pane.hasAttribute("inert"),
        ),
    );
    const resumed = [
      reopened.locator('section[data-pane="0"] .cm-line').filter({ hasText: "第064段" }),
      reopened.locator('section[data-pane="1"] .ProseMirror > p').filter({ hasText: "第088段" }),
    ];
    for (const [index, element] of resumed.entries()) {
      await expect.poll(() => element.count()).toBe(1);
      const expected = index === 0 ? leftBeforeClose : rightBeforeClose;
      await expect
        .poll(async () =>
          Math.abs(
            (await element.evaluate(
              (node) =>
                node.getBoundingClientRect().top -
                node.closest(".main")!.getBoundingClientRect().top,
            )) - expected,
          ),
        )
        .toBeLessThan(24);
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("长文阅读连续性：文内跳转、后退前进与跨文档返回保留实际阅读位置", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-reading-position-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const paragraphs = Array.from(
    { length: 60 },
    (_, index) =>
      `${index === 30 ? "## 第二节\n\n" : ""}第 ${index + 1} 段。${"读到哪里，返回时就应留在哪里。".repeat(8)}${index === 10 ? " [[#第二节]]" : ""}`,
  ).join("\n\n");
  const callout =
    "> [!note] 长标注\n>\n" +
    Array.from(
      { length: 24 },
      (_, index) => `> 标注第 ${index} 段。${"读写切换保留当前位置。".repeat(12)}`,
    ).join("\n>\n");
  await Promise.all([
    writeFile(join(vault, "长文.md"), `# 连续阅读\n\n${paragraphs}\n\n${callout}\n`),
    writeFile(join(vault, "另一篇.md"), `# 另一篇\n\n${paragraphs}\n\n${callout}\n`),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          currentPath: "长文.md",
          filesCollapsed: false,
          viewModes: { "长文.md": "reading", "另一篇.md": "reading" },
        },
        window: { width: 1100, height: 720 },
      }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
      "--no-sandbox",
    ],
    env: environment,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ready = (name: string) =>
      page.waitForFunction(
        (expected) =>
          document.querySelector(".document-name")?.textContent === expected &&
          !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        name,
      );
    const scroller = page.locator("section[data-pane]");
    const top = () => scroller.evaluate((element) => element.scrollTop);
    const near = async (expected: number) => {
      await expect.poll(async () => Math.abs((await top()) - expected)).toBeLessThan(2);
    };
    await ready("长文.md");
    const link = page.locator('.surface .wiki-link[data-wiki-target="#第二节"]');
    await link.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const departure = await top();
    expect(departure).toBeGreaterThan(500);
    await link.click();
    await expect.poll(top).toBeGreaterThan(departure + 500);
    await scroller.evaluate((element) => {
      element.scrollTop += 330;
    });
    const continued = await top();
    await page.keyboard.press("ControlOrMeta+[");
    await near(departure);
    await page.keyboard.press("ControlOrMeta+]");
    await near(continued);

    await page.getByRole("treeitem", { name: "另一篇.md", exact: true }).click();
    await ready("另一篇.md");
    await near(0);
    await scroller.evaluate((element) => {
      element.scrollTop = 650;
    });
    await page.keyboard.press("ControlOrMeta+[");
    await ready("长文.md");
    await near(continued);
    await page.keyboard.press("ControlOrMeta+]");
    await ready("另一篇.md");
    await near(650);
    const paragraphs = page.locator(".ProseMirror > p");
    const visible = await paragraphs.evaluateAll((elements) => {
      const top = elements[0]?.closest(".main")?.getBoundingClientRect().top ?? 0;
      return elements.findIndex((element) => element.getBoundingClientRect().top >= top);
    });
    expect(visible).toBeGreaterThan(0);
    const paragraph = paragraphs.nth(visible);
    const paragraphTop = (await paragraph.boundingBox())?.y;
    if (paragraphTop === undefined) throw new Error("缺少可见阅读段落");
    // 模式切换会显示或隐藏属性入口；保持相同段落在屏幕上的位置，而非机械地固定 scrollTop。
    const sameParagraph = async () => {
      await expect
        .poll(async () => Math.abs(((await paragraph.boundingBox())?.y ?? 0) - paragraphTop))
        .toBeLessThan(1);
    };
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await expect
      .poll(() => page.locator(".ProseMirror").getAttribute("contenteditable"))
      .toBe("true");
    await sameParagraph();
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await sameParagraph();
    const settleLayout = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    await settleLayout();
    const calloutParagraph = page.locator(".callout-content p").filter({ hasText: "标注第 12 段" });
    await calloutParagraph.evaluate((element) => element.scrollIntoView({ block: "start" }));
    const calloutTop = (await calloutParagraph.boundingBox())!.y;
    for (const editable of ["true", "false"]) {
      await page.keyboard.press("ControlOrMeta+Shift+e");
      await expect
        .poll(() => page.locator(".ProseMirror").getAttribute("contenteditable"))
        .toBe(editable);
      await settleLayout();
      await expect
        .poll(async () => Math.abs(((await calloutParagraph.boundingBox())?.y ?? 0) - calloutTop))
        .toBeLessThan(1);
    }

    // 查找命中必须露在粘性搜索栏下方；关闭后正文继续持有选区和键盘焦点。
    await page.keyboard.press("ControlOrMeta+f");
    const query = page.getByRole("searchbox", { name: "查找", exact: true });
    await query.fill("第 45 段");
    const searchStatus = page.getByRole("form", { name: "文内查找替换" }).getByRole("status");
    await expect.poll(() => searchStatus.textContent()).toBe("共 1 处");
    await page.keyboard.press("Enter");
    const match = page.locator(".ProseMirror-active-search-match");
    await expect.poll(() => match.textContent()).toBe("第 45 段");
    await expect.poll(() => searchStatus.textContent()).toBe("第 1 处，共 1 处");
    await expect
      .poll(() =>
        match.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const main = element.closest(".main")!;
          return Math.min(
            bounds.top - main.querySelector(".search-panel")!.getBoundingClientRect().bottom,
            main.getBoundingClientRect().bottom - bounds.bottom,
          );
        }),
      )
      .toBeGreaterThanOrEqual(0);
    expect(await query.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => query.count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.matches(".ProseMirror"))).toBe(true);
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("第 45 段");
    const readingParagraph = page.locator(".ProseMirror > p").filter({ hasText: "第 45 段" });
    await settleLayout();
    const readingTop = (await readingParagraph.boundingBox())!.y;
    const diskSource = await readFile(join(vault, "另一篇.md"), "utf8");
    await writeFile(
      join(vault, "另一篇.md"),
      diskSource.replace("# 另一篇\n", "# 另一篇\n\n外部新增前言。\n"),
    );
    await page.getByText("外部新增前言。", { exact: true }).waitFor({ state: "attached" });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.matches(".ProseMirror")))
      .toBe(true);
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("第 45 段");
    await settleLayout();
    expect(Math.abs((await readingParagraph.boundingBox())!.y - readingTop)).toBeLessThan(2);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("阅读视图：查找与导航可用，正文和任务只读，返回编辑保留历史，模式随会话记住", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-reading-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const source =
    "# 阅读\n\n正文 %%私下的注释%% 结尾。\n\n- [ ] 待办\n\n见 [[目标]]。\n\n" +
    "> [!note]- 外层标注\n>\n> > [!tip]- 内层标注\n> >\n" +
    Array.from({ length: 20 }, (_, index) => `> > 折叠中的第 ${index} 段说明。\n`).join("> >\n") +
    "> >\n> > 折叠内定位目标。\n\n> [!warning]- 旁支\n> 无关内容。\n";
  await Promise.all([
    writeFile(join(vault, "阅读.md"), source),
    // 引用续行会被 Markdown 解析器去掉前缀；中文提及必须仍按原文件字节定位。
    writeFile(join(vault, "目标.md"), "# 目标\n\n> 阅读提示\n> 每个阅读表面保持一致。\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "阅读.md", filesCollapsed: false, leftWidth: 260 },
        appearance: "light",
        window: { x: 0, y: 0, width: 1100, height: 720, maximized: true },
      }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  }
  const launch = () =>
    electron.launch({
      executablePath: executable,
      colorScheme: null,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${userData}`,
        "--no-sandbox",
      ],
      env: environment,
    });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ready = (name: string) =>
      page.waitForFunction(
        (expected) =>
          document.querySelector(".document-name")?.textContent === expected &&
          !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        name,
      );
    await ready("阅读.md");
    const editor = page.locator(".ProseMirror");
    if (environment.NOUS_TEST_WINDOW === "hidden") {
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
          })),
        ),
      ).toEqual([{ visible: false, focused: false }]);
    }

    await page.keyboard.press("ControlOrMeta+Shift+e");
    await expect.poll(() => editor.getAttribute("contenteditable")).toBe("false");
    expect(await editor.locator(".comment-inline").isVisible()).toBe(false);

    // 阅读态保留查找；输入、替换和任务勾选都不能改写磁盘内容。
    expect(await editor.locator(".task-checkbox").isDisabled()).toBe(true);
    await editor.locator("p").first().click();
    await page.keyboard.type("不应写入");
    await page.keyboard.press("ControlOrMeta+f");
    await page.getByRole("searchbox", { name: "查找", exact: true }).fill("正文");
    await page.locator(".ProseMirror-search-match").waitFor();
    expect(await page.getByRole("button", { name: "替换选项" }).count()).toBe(0);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect
      .poll(() => editor.evaluate((element) => document.activeElement === element))
      .toBe(true);
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("正文");
    // 查询高亮保留折叠；真正定位时先展开所有祖先，命中再滚入查找栏下方。
    const callouts = editor.locator(".callout");
    expect(await callouts.count()).toBe(3);
    expect(await editor.locator(".callout.collapsed").count()).toBe(3);
    await page.keyboard.press("ControlOrMeta+f");
    const query = page.getByRole("searchbox", { name: "查找", exact: true });
    await query.fill("折叠内定位目标");
    await expect
      .poll(() =>
        page.getByRole("form", { name: "文内查找替换" }).getByRole("status").textContent(),
      )
      .toBe("共 1 处");
    expect(await editor.locator(".callout.collapsed").count()).toBe(3);
    await page.keyboard.press("Enter");
    const match = editor.locator(".ProseMirror-active-search-match");
    await expect.poll(() => match.isVisible()).toBe(true);
    expect(await editor.locator(".callout.collapsed").count()).toBe(1);
    expect(
      await editor
        .locator('.callout[data-callout="warning"] .callout-fold')
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await expect
      .poll(() =>
        match.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const main = element.closest(".main")!;
          return Math.min(
            bounds.top - main.querySelector(".search-panel")!.getBoundingClientRect().bottom,
            main.getBoundingClientRect().bottom - bounds.bottom,
          );
        }),
      )
      .toBeGreaterThanOrEqual(0);
    expect(await query.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("折叠内定位目标");
    await page.keyboard.press("ControlOrMeta+s");
    expect(await readFile(join(vault, "阅读.md"), "utf8")).toBe(source);

    // 编辑后进入阅读，撤销不得改写；返回编辑仍可撤销原来的勾选。
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await editor.locator(".task-checkbox").click();
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await editor.locator(".task-checkbox").getAttribute("aria-checked")).toBe("true");
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(() => editor.locator(".task-checkbox").getAttribute("aria-checked"))
      .toBe("false");
    await editor.locator(".task-checkbox").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "阅读.md"), "utf8"))
      .toBe(source.replace("- [ ] 待办", "- [x] 待办"));
    await page.keyboard.press("ControlOrMeta+Shift+e");

    // 阅读视图里单击链接即跳转。
    await editor.locator('.wiki-link[data-wiki-target="目标"]').click();
    await ready("目标.md");
    await page.keyboard.press("ControlOrMeta+[");
    await ready("阅读.md");
    await expect.poll(() => editor.getAttribute("contenteditable")).toBe("false");

    // 阅读 → 源码 → 阅读：跨源码边界交接文本。
    await page.keyboard.press("ControlOrMeta+e");
    await page.locator(".cm-content").waitFor();
    expect(await page.locator(".cm-content").textContent()).toContain("%%私下的注释%%");
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await expect.poll(() => editor.getAttribute("contenteditable")).toBe("false");
    await expect
      .poll(async () => {
        const session = JSON.parse(await readFile(join(userData, "session.json"), "utf8"));
        return session.reader?.viewModes as Record<string, string> | undefined;
      })
      .toEqual({ "阅读.md": "reading" });
    expect(errors).toEqual([]);

    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.waitForFunction(
      () => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "false",
    );
  } finally {
    await app.close();
  }
});
