import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("固定应用仓库接入旧库和文章历史，根目录与子目录都有明确操作入口", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "noemori-managed-library-")));
  t.onTestFinished(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "NNDL-Bilingual"),
    library = join(base, "Noemori"),
    state = join(base, "state");
  const path = "章节/03-Improving-the-Way-Neural-Networks-Learn.md";
  const original =
    "# 改进神经网络的学习方式\n\n理解知识，也让知识之间建立联系。\n\n## 交叉熵代价函数\n\n从误差开始改进。\n";
  const extra = join(base, "本地资料");
  await mkdir(join(source, "章节"), { recursive: true });
  await mkdir(join(source, "assets"));
  await mkdir(join(source, "attachments"));
  await mkdir(extra);
  await mkdir(state);
  await Promise.all([
    writeFile(join(source, path), original),
    writeFile(join(source, "章节/01-基础概念.md"), "# 基础概念\n"),
    writeFile(join(source, "00-README.md"), "# 神经网络与深度学习\n"),
    writeFile(join(source, "06-Deep-Learning.md"), "# 深度学习\n"),
    writeFile(join(extra, "方法.md"), "# 新资料\n"),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({
        appearance: "dark",
        readingPalette: "monochrome",
        reader: { vaultRoot: source, currentPath: path, filesCollapsed: false, leftWidth: 252 },
      }),
    ),
  ]);
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const launch = (root: string) =>
    electron.launch({
      executablePath,
      args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: "",
        NOEMORI_TEST_LIBRARY_ROOT: root,
        NOEMORI_TEST_WINDOW: "hidden",
      },
    });
  const previous = await launch(source);
  let conversation: { id: string }, fork: { id: string };
  try {
    const page = await previous.firstWindow();
    await page.locator(".ProseMirror").waitFor();
    ({ conversation, fork } = await page.evaluate(
      async ({ root, path }) => {
        const conversation = await window.noemori.agent.createArticle({
          root,
          path,
          title: "交叉熵为什么更好？",
        });
        const fork = await window.noemori.agent.fork(conversation.id, {
          title: "推导与例子",
          afterTurnId: null,
        });
        return { conversation: { id: conversation.id }, fork: { id: fork.id } };
      },
      { root: source, path },
    ));
  } finally {
    await previous.close();
  }
  const note = `${original}\n[讨论：交叉熵为什么更好？](noemori://conversation/${conversation.id})\n`;
  await writeFile(join(source, path), note);
  const historyPath = join(source, ".noemori/agent/conversations", `${conversation.id}.json`);
  const originalHistory = await readFile(historyPath);
  const app = await launch(library);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(1100, 760);
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    await page.evaluate(() => window.noemori.app.appearanceSet("dark"));
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.evaluate(() => document.fonts.ready);
    const sidebar = page.locator(".file-sidebar:not(.right)");
    const files = sidebar.getByRole("navigation", { name: "文件列表" });
    const row = (path: string) => files.locator(`.file[data-path="${path}"]`);
    await row(`NNDL-Bilingual/${path}`).waitFor();
    expect(await files.locator(".root-label h2").textContent()).toBe("Noemori");
    expect(await files.getByRole("button", { name: "笔记库根目录" }).count()).toBe(0);
    await files.locator(".root-label").click();
    expect(await files.locator('.file[aria-current="page"]').getAttribute("data-path")).toBe(
      `NNDL-Bilingual/${path}`,
    );
    const imported = await page.evaluate(
      async (id) => window.noemori.agent.snapshot(id),
      conversation.id,
    );
    expect(imported.workspace).toBe(library);
    expect(imported.article?.path).toBe(`NNDL-Bilingual/${path}`);
    expect(
      (await page.evaluate(async (id) => window.noemori.agent.snapshot(id), fork.id)).origin
        ?.conversationId,
    ).toBe(conversation.id);
    expect(await readFile(historyPath)).toEqual(originalHistory);
    expect(await readFile(join(source, path), "utf8")).toBe(note);

    const more = files.getByRole("button", { name: "目录操作", exact: true });
    await more.click();
    await files
      .locator(".options-menu")
      .getByRole("button", { name: "新建文件夹…", exact: true })
      .click();
    const create = page.getByRole("dialog", { name: "新建文件夹", exact: true });
    await create.getByRole("textbox", { name: "名称", exact: true }).fill("研究资料");
    expect(await create.locator(".destination").textContent()).toContain("研究资料");
    await create.getByRole("button", { name: "创建", exact: true }).click();
    await row("研究资料").waitFor();
    await row("研究资料").hover();
    await files.getByRole("button", { name: "研究资料 的操作", exact: true }).click();
    const menu = page.getByRole("menu", { name: "文件操作", exact: true });
    await menu.getByRole("menuitem", { name: "新建子文件夹…", exact: true }).click();
    await create.getByRole("textbox", { name: "名称", exact: true }).fill("实验");
    expect(await create.locator(".destination").textContent()).toContain("研究资料/实验");
    await create.getByRole("button", { name: "创建", exact: true }).click();
    await row("研究资料/实验").waitFor();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, extra);
    await row("研究资料").hover();
    await files.getByRole("button", { name: "研究资料 的操作", exact: true }).click();
    await menu.getByRole("menuitem", { name: "导入文件夹…", exact: true }).click();
    await row("研究资料/本地资料").waitFor();
    expect(await readFile(join(library, "研究资料/本地资料/方法.md"), "utf8")).toBe("# 新资料\n");
    expect(await readFile(join(extra, "方法.md"), "utf8")).toBe("# 新资料\n");
    expect(await files.locator('.file[aria-current="page"]').getAttribute("data-path")).toBe(
      `NNDL-Bilingual/${path}`,
    );
    expect(JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.vaultRoot).toBe(
      library,
    );

    const expand = row(`NNDL-Bilingual/${path}`).locator("..").locator(".tree-toggle");
    if ((await expand.getAttribute("aria-expanded")) !== "true") await expand.click();
    const chat = files.getByRole("button", { name: "交叉熵为什么更好？", exact: true });
    await chat.click();
    await page
      .locator(".agent-panel")
      .getByRole("heading", { name: "交叉熵为什么更好？", exact: true })
      .waitFor();
    const branch = chat.locator("..").locator(".tree-toggle");
    if ((await branch.getAttribute("aria-expanded")) !== "true") await branch.click();
    await files.getByRole("button", { name: "推导与例子", exact: true }).waitFor();
    expect(await chat.getAttribute("aria-pressed")).toBe("true");
    expect(await chat.locator(".conversation-active").count()).toBe(1);
    expect(await files.locator(".current-status").count()).toBe(0);
    expect(await files.textContent()).not.toContain("对话中");
    expect(
      await chat
        .locator(".conversation-active")
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    const forkActions = files.getByRole("button", { name: "推导与例子 的操作", exact: true });
    await forkActions.focus();
    await forkActions.press("Enter");
    const conversationMenu = page.getByRole("menu", { name: "对话操作", exact: true });
    await conversationMenu.waitFor();
    await page.keyboard.press("End");
    expect(await conversationMenu.getByRole("menuitem", { name: "删除对话…", exact: true })
      .evaluate(element => element === document.activeElement)).toBe(true);
    expect(await chat.getAttribute("aria-pressed")).toBe("true");
    await page.keyboard.press("Escape");
    expect(await forkActions.evaluate(element => element === document.activeElement)).toBe(true);
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    await editor.click();
    await page.mouse.move(600, 700);
    const captures = process.env.NOEMORI_MANAGED_LIBRARY_SCREENSHOTS;
    if (captures) {
      await page.screenshot({ path: join(captures, "managed-library-workspace.png") });
      await sidebar.screenshot({ path: join(captures, "managed-library-sidebar.png") });
      await row(`NNDL-Bilingual/${path}`).hover();
      await sidebar.screenshot({ path: join(captures, "managed-library-hover.png") });
      await row("研究资料").hover();
      await files.getByRole("button", { name: "研究资料 的操作", exact: true }).click();
      await menu.waitFor();
      await page.screenshot({ path: join(captures, "managed-library-folder-menu.png") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => window.noemori.app.appearanceSet("light"));
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await editor.click();
      await page.mouse.move(600, 700);
      await page.screenshot({ path: join(captures, "managed-library-light.png") });
      await page.evaluate(() => window.noemori.app.appearanceSet("dark"));
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    }
    await page.getByRole("separator", { name: "调整侧栏宽度", exact: true }).press("Home");
    await editor.click();
    await more.click();
    await files
      .locator(".options-menu")
      .getByRole("button", { name: "导入文件夹…", exact: true })
      .waitFor();
    if (captures)
      await page.screenshot({ path: join(captures, "managed-library-narrow-menu.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
}, 60000);
