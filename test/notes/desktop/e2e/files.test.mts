import { confirmNewEntry, newEntry } from "../support/workspace-actions";
import {
  noteAction,
  openLibrary,
  openSettings,
  sidebarComponent,
} from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("批量进度经真实 Rust 运行时交付，停止与继续保留文件和链接", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-batch-progress-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(join(vault, "archive"), { recursive: true }), mkdir(userData)]);
  const names = Array.from({ length: 80 }, (_, i) => `batch${String(i).padStart(3, "0")}.md`);
  for (let offset = 0; offset < 1000; offset += 100)
    await Promise.all(
      Array.from({ length: 100 }, (_, index) => {
        const i = offset + index;
        return writeFile(
          join(vault, names[i] ?? `sibling${i}.md`),
          `# Note ${i}\n\n[next](./${names[(i + 1) % names.length]})\n\n${"保持完整内容与链接关系。Content and references remain intact.\n\n".repeat(20)}`,
        );
      }),
    );
  await writeFile(join(userData, "session.json"), JSON.stringify({ vaultRoot: vault }));
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = { NOEMORI_TEST_WINDOW: "hidden" };
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL" && name !== "NOEMORI_TEST_WINDOW")
      environment[name] = value;
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
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
    const page = await app.firstWindow();
    await openLibrary(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const files = page.locator(".library").getByRole("navigation", { name: "文件列表" });
    const search = files.getByRole("searchbox");
    await files.locator('[data-path="batch000.md"]').waitFor();
    await search.fill("batch");
    await search.press("ArrowDown");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await files.locator('[data-path="batch000.md"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "移动到…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "批量移动", exact: true });
    await dialog.getByRole("combobox", { name: "目标文件夹" }).fill("archive");
    await dialog.getByRole("option", { name: "archive", exact: true }).click();
    await dialog.getByRole("button", { name: "移动", exact: true }).click();
    await page.waitForFunction(() => {
      const progress = document.querySelector<HTMLProgressElement>(".batch-dialog progress");
      return progress !== null && progress.value > 0 && progress.max === 80;
    });
    const screenshots = process.env.NOEMORI_FILE_MANAGER_SCREENSHOTS;
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-batch-progress.png") });
    await dialog.getByRole("button", { name: "停止", exact: true }).click();
    const retry = dialog.getByRole("button", { name: "继续剩余项", exact: true });
    await retry.waitFor();
    await expect.poll(() => retry.isEnabled()).toBe(true);
    expect(await dialog.innerText()).toContain("已停止");
    const moved = await readdir(join(vault, "archive"));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThan(80);
    for (const name of names) {
      const path = moved.includes(name) ? `archive/${name}` : name;
      expect(await readFile(join(vault, path), "utf8")).toContain(
        "Content and references remain intact.",
      );
    }
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-batch-stopped.png") });
    await retry.click();
    await dialog.waitFor({ state: "hidden" });
    expect((await readdir(join(vault, "archive"))).sort()).toEqual(names);
    for (const [index, name] of names.entries())
      expect(await readFile(join(vault, "archive", name), "utf8")).toContain(
        `[next](./${names[(index + 1) % names.length]})`,
      );
    expect(
      await page.evaluate(
        async () => (await window.noemori.reader.indexLinksFrom("archive/batch000.md"))[0]?.toPath,
      ),
    ).toBe("archive/batch001.md");
    expect(errors).toEqual([]);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("万项层级目录的虚拟滚动、键盘导航与隐藏恢复保持稳定", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-files-scroll-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  for (let batch = 0; batch < 100; batch++)
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(join(vault, `笔记${batch * 100 + index}.md`), "# 笔记\n"),
      ),
    );
  await writeFile(join(userData, "session.json"), JSON.stringify({ vaultRoot: vault }));
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
    await openLibrary(page);
    const tree = page.getByRole("treegrid", { name: "文件与对话" });
    await tree.waitFor();
    await tree.evaluate((node) => {
      node.scrollTop = node.scrollHeight / 2;
    });
    const middle = tree.locator('[data-path="笔记5000.md"]');
    await middle.waitFor();
    await middle.focus();
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await middle.dispatchEvent("dragstart", { dataTransfer: transfer });
    await tree.evaluate((node) => {
      node.scrollTop = 0;
    });
    await middle.dispatchEvent("dragend", { dataTransfer: transfer });
    await transfer.dispose();
    await page.keyboard.press("ArrowDown");
    expect(
      await tree
        .locator('[data-path="笔记5001.md"]')
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    const beforeHide = await tree.evaluate((node) => node.scrollTop);
    await sidebarComponent(page, "目录");
    await openLibrary(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(beforeHide);
    await tree.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // 触控板可以停在行末的半像素处，记录与恢复滚动锚点不能把它向上截断。
    const fractional = await tree.evaluate((node) => {
      const row = node.querySelector(".tree-row")!;
      node.scrollTop = row.getBoundingClientRect().height - 0.5;
      return node.scrollTop;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await tree.evaluate((node) => node.scrollTop)).toBe(fractional);

    const files = page.locator(".library").getByRole("navigation", { name: "文件列表" });
    const search = files.getByRole("searchbox");
    const row = (path: string) => tree.locator(`[data-path="${path}"]`);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await search.fill("path:笔记500");
    await search.press("Enter");
    await expect.poll(() => files.locator(".status").innerText()).toContain("共 11 篇");
    await search.press("ArrowDown");
    await page.keyboard.press(`${modifier}+ArrowDown`);
    expect(await row("笔记5000.md").evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await row("笔记500.md").locator('xpath=ancestor::*[@role="gridcell"]').getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("Delete");
    const trash = page.getByRole("dialog", { name: "移到废纸篓", exact: true });
    await trash.waitFor();
    expect(await trash.innerText()).toContain("笔记500.md");
    expect(await trash.innerText()).not.toContain("笔记5000.md");
    await trash.getByRole("button", { name: "取消", exact: true }).click();
    await row("笔记5000.md").focus();
    await page.keyboard.press("F2");
    const rename = files.getByRole("textbox", { name: "重命名文件", exact: true });
    expect(await rename.inputValue()).toBe("笔记500.md");
    await rename.press("Escape");
    await page.keyboard.press("Space");
    await page.keyboard.press("Delete");
    await expect.poll(() => trash.isVisible()).toBe(false);
    expect(await tree.locator('[aria-selected="true"]').count()).toBe(0);
    await row("笔记5000.md").click({ modifiers: [modifier] });
    expect(await row("笔记5000.md").evaluate((node) => node === document.activeElement)).toBe(true);
    await rm(join(vault, "笔记5000.md"));
    // 原生监视器异步通知目录变化；条目移除后再验证渲染周期内的焦点交接。
    await row("笔记5000.md").waitFor({ state: "detached" });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-path")))
      .toBe("笔记5001.md");
    expect(await tree.locator('[aria-selected="true"]').count()).toBe(0);
    await page.keyboard.press("ArrowDown");
    expect(await row("笔记5002.md").locator('xpath=ancestor::*[@role="gridcell"]').getAttribute("aria-selected")).toBe("true");
  } finally {
    await app.close();
  }
});

test("统一目录支持搜索、新建、重命名、移动、拖拽与窄屏打开", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-files-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([
    mkdir(join(vault, "项目/研究"), { recursive: true }),
    mkdir(join(vault, "项目/空文件夹"), { recursive: true }),
    mkdir(join(vault, "归档"), { recursive: true }),
    mkdir(join(vault, "归档/浏览"), { recursive: true }),
    mkdir(join(vault, "收件箱"), { recursive: true }),
    mkdir(userData),
  ]);
  await Promise.all([
    ...Array.from({ length: 180 }, (_, index) =>
      writeFile(join(vault, `归档/浏览/记录${index}.md`), "# 浏览位置\n"),
    ),
    writeFile(
      join(vault, "项目/研究/笔记.md"),
      "# 研究笔记\n\n从想法开始。\n\n[返回索引](../../索引.md)\n",
    ),
    writeFile(join(vault, "归档/笔记.md"), "# 旧笔记\n"),
    writeFile(join(vault, "项目/研究/未命名.md"), "# 已有笔记\n"),
    writeFile(join(vault, "索引.md"), "# 索引\n\n[研究笔记](项目/研究/笔记.md)\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          currentPath: "项目/研究/笔记.md",
          filesCollapsed: false,
          leftWidth: 260,
        },
        appearance: "light",
        window: null,
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
    await openLibrary(page);
    const assertHidden = async () => {
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
          })),
        ),
      ).toEqual([{ visible: false, focused: false }]);
    };
    await assertHidden();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const files = page.locator(".library").getByRole("navigation", { name: "文件列表" });
    const row = (path: string) => files.locator(`[data-path="${path}"]`);
    const active = async (path: string) => {
      await page.waitForFunction(
        (value) =>
          document.querySelector(".topbar-document .document-name")?.getAttribute("title") ===
            value && !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        path,
      );
    };
    const dialog = page.locator(".entry-dialog");
    const creation = page.locator(".create-dialog");
    const contextAction = async (path: string, label: string) => {
      await openLibrary(page);
      await row(path).click({ button: "right" });
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    const createRootFolder = async () => {
      await openLibrary(page);
      await files.getByRole("button", { name: "笔记库根目录", exact: true }).click();
      await newEntry(page, "文件夹");
    };
    const nameAndSubmit = async (name: string, label: string) => {
      await dialog.locator("input").fill(name);
      await dialog.getByRole("button", { name: label, exact: true }).click();
    };
    const screenshots = process.env.NOEMORI_FILE_MANAGER_SCREENSHOTS;
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    page.setDefaultTimeout(6000);
    const browse = async (path: string) => {
      await openLibrary(page);
      await files.getByRole("button", { name: "笔记库根目录", exact: true }).click();
      if (path) {
        await files.getByRole("searchbox").fill(path);
        await row(path).dblclick();
      }
    };
    const selected = (path: string) => row(path).locator('xpath=ancestor::*[@role="gridcell"]').getAttribute("aria-selected");
    await active("项目/研究/笔记.md");
    await row("项目/研究/笔记.md").waitFor();
    expect(await row("项目").count()).toBe(1);
    await browse("项目");
    await row("项目").click();
    expect(await row("项目/研究").count()).toBe(0);
    await row("项目").dblclick();
    await row("项目/空文件夹").waitFor();
    const search = files.getByRole("searchbox");
    await search.fill("笔记.md");
    expect(await row("项目/研究/笔记.md").isVisible()).toBe(true);
    expect(await row("归档/笔记.md").isVisible()).toBe(true);
    await search.press("Escape");
    await row("项目/研究/笔记.md").click();
    expect(await row("项目/研究/笔记.md").count()).toBe(1);
    expect(await row("项目/研究/笔记.md").evaluate((node) => document.activeElement === node)).toBe(
      true,
    );
    await newEntry(page, "笔记");
    await confirmNewEntry(page);
    await active("项目/研究/未命名 2.md");
    expect(await readFile(join(vault, "项目/研究/未命名 2.md"), "utf8")).toBe("");
    await noteAction(page, "重命名…");
    await dialog.locator("input").fill("输入中的名称.md");
    await page.keyboard.press(`${modifier}+n`);
    expect(await dialog.locator("input").inputValue()).toBe("输入中的名称.md");
    await page.keyboard.press("Escape");

    await browse("归档/浏览");
    const grid = files.getByRole("treegrid");
    await grid.evaluate((node) => {
      node.scrollTop = 900;
    });
    await expect.poll(() => grid.evaluate((node) => node.scrollTop)).toBe(900);
    await search.fill("研究/笔记");
    await expect.poll(() => grid.evaluate((node) => node.scrollTop)).toBe(0);
    await search.press("Escape");
    await expect.poll(() => grid.evaluate((node) => node.scrollTop)).toBe(900);

    await browse("");
    await createRootFolder();
    await confirmNewEntry(page, "资料");
    expect((await stat(join(vault, "资料"))).isDirectory()).toBe(true);
    expect(await selected("资料")).toBe("true");
    await createRootFolder();
    await creation.getByRole("textbox", { name: "名称", exact: true }).fill("资料");
    expect(await creation.getByRole("button", { name: "创建", exact: true }).isDisabled()).toBe(true);
    await creation.getByRole("button", { name: "取消", exact: true }).click();
    await browse("资料");
    await newEntry(page, "笔记");
    await confirmNewEntry(page);
    await active("资料/未命名.md");
    await noteAction(page, "重命名…");
    await nameAndSubmit("入门.md", "重命名");
    await active("资料/入门.md");
    await page.locator(".ProseMirror").click();
    await page.keyboard.insertText("创建后的内容会先保存，再移动。 ");
    await browse("项目/研究");
    await row("项目/研究/笔记.md").dblclick();
    await active("项目/研究/笔记.md");
    expect(await readFile(join(vault, "资料/入门.md"), "utf8")).toContain("创建后的内容");

    await browse("项目");
    await row("项目").click();
    await row("项目").press("F2");
    const renameFolder = files.getByRole("textbox", { name: "重命名文件夹", exact: true });
    await renameFolder.fill("计划");
    await renameFolder.press("Enter");
    await active("计划/研究/笔记.md");
    expect(await selected("计划")).toBe("true");
    await contextAction("计划", "移动到…");
    const destination = dialog.getByRole("combobox", { name: "目标文件夹" });
    expect(await dialog.getByRole("option", { name: "计划/研究", exact: true }).count()).toBe(0);
    await destination.fill("不存在");
    expect(await dialog.getByRole("button", { name: "移动", exact: true }).isDisabled()).toBe(true);
    await destination.fill("资料");
    await dialog.getByRole("option", { name: "资料", exact: true }).click();
    await dialog.getByRole("button", { name: "移动", exact: true }).click();
    await active("资料/计划/研究/笔记.md");
    expect(await selected("资料/计划")).toBe("true");
    expect(decodeURI(await readFile(join(vault, "索引.md"), "utf8"))).toContain(
      "资料/计划/研究/笔记.md",
    );
    expect(decodeURI(await readFile(join(vault, "资料/计划/研究/笔记.md"), "utf8"))).toContain(
      "../../../索引.md",
    );
    expect((await stat(join(vault, "资料/计划/空文件夹"))).isDirectory()).toBe(true);

    // 网格可在同一文件夹内拖入子目录，也可拖到根目录面包屑。
    await row("资料/入门.md").dragTo(row("资料/计划"));
    await row("资料/计划/入门.md").waitFor();
    await row("资料/计划/入门.md").dragTo(
      files.getByRole("button", { name: "笔记库根目录", exact: true }),
    );
    await row("入门.md").waitFor();
    await files.getByRole("button", { name: "目录操作", exact: true }).click();
    await files.getByRole("button", { name: "折叠全部目录", exact: true }).click();
    await row("入门.md").dragTo(row("收件箱"));
    await row("收件箱/入门.md").waitFor();
    await row("收件箱/入门.md").dblclick();
    await active("收件箱/入门.md");
    await openLibrary(page);
    await row("收件箱/入门.md").click();
    await row("收件箱/入门.md").press("F2");
    const renameFile = files.getByRole("textbox", { name: "重命名文件", exact: true });
    await renameFile.fill("完成.md");
    await renameFile.press("Enter");
    await active("收件箱/完成.md");
    await row("收件箱/完成.md").press("Delete");
    expect(await dialog.innerText()).toContain("可以从系统废纸篓恢复");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(await readFile(join(vault, "收件箱/完成.md"), "utf8")).toContain("创建后的内容");
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-light.png") });

    await openSettings(page);
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 600, height: 700 });
    await openLibrary(page);
    await row("收件箱/完成.md").click();
    await expect.poll(() => page.getByRole("complementary", { name: "文件栏", exact: true }).isVisible()).toBe(false);
    await expect.poll(() => page.locator(".reading-space .ProseMirror").innerText()).toContain("创建后的内容");
    await openLibrary(page);
    await row("收件箱/完成.md").press("F2");
    await renameFile.fill("../错误.md");
    expect(await files.getByRole("alert").isVisible()).toBe(true);
    await renameFile.press("Escape");
    await row("收件箱/完成.md").click({ button: "right" });
    const bounds = (await page.getByRole("menu", { name: "文件操作" }).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(592);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(692);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-narrow.png") });
    await row("收件箱/完成.md").dblclick();
    await expect
      .poll(() => page.getByRole("complementary", { name: "文件栏" }).isVisible())
      .toBe(false);
    expect(errors).toEqual([]);
    await assertHidden();
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.locator(".ProseMirror").waitFor();
    expect(await reopened.locator(".ProseMirror").innerText()).toContain("创建后的内容");
  } finally {
    await app.close();
  }
});

test("空库新建直接进入写作，窄窗口交还焦点且保存后可重启恢复", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-empty-files-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({ reader: { vaultRoot: vault, filesCollapsed: false } }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron 可执行文件");
  const launch = () =>
    electron.launch({
      executablePath,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${userData}`,
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
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    await page.getByRole("heading", { name: "从第一篇笔记开始", exact: true }).waitFor();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    for (const [width, path] of [
      [1100, "未命名.md"],
      [600, "未命名 2.md"],
    ] as const) {
      const height = width === 600 ? 480 : 700;
      await page.setViewportSize({ width, height });
      await sidebarComponent(page, "目录");
      await page.keyboard.press(`${modifier}+n`);
      const creation = page.locator(".create-dialog[open]");
      await creation.waitFor();
      const footer = (await creation.locator("footer").boundingBox())!;
      expect(footer.y + footer.height).toBeLessThanOrEqual(height - 16);
      await confirmNewEntry(page);
      const editor = page.locator(".ProseMirror");
      await expect
        .poll(() => editor.evaluate((node) => node.contains(document.activeElement)))
        .toBe(true);
      if (width === 600)
        await expect
          .poll(() => page.getByRole("complementary", { name: "文件栏" }).isVisible())
          .toBe(false);
      await page.keyboard.insertText(`在 ${width} 像素窗口直接写作。`);
      await page.keyboard.press(`${modifier}+s`);
      await expect
        .poll(() => readFile(join(vault, path), "utf8"))
        .toContain(`在 ${width} 像素窗口直接写作。`);
    }
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.locator(".ProseMirror").waitFor();
    expect(await reopened.locator(".ProseMirror").innerText()).toContain(
      "在 600 像素窗口直接写作。",
    );
  } finally {
    await app.close();
  }
});

test("批量移动整批预检，外部变更与重启保留目录现场", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-batch-files-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all(
    ["source", "target", "browse"].map((path) => mkdir(join(vault, path), { recursive: true })),
  );
  await mkdir(userData);
  await Promise.all([
    writeFile(join(vault, "source/a.md"), "# A\n\n[B](b.md)\n"),
    writeFile(join(vault, "source/b.md"), "# B\n\n[A](a.md)\n"),
    writeFile(join(vault, "target/b.md"), "# 已有内容，不得覆盖\n"),
    writeFile(join(vault, "index.md"), "[A](source/a.md)\n\n[B](source/b.md)\n"),
    ...Array.from({ length: 150 }, (_, i) =>
      writeFile(join(vault, `browse/note-${String(i).padStart(3, "0")}.md`), "# 浏览锚点\n"),
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          currentPath: "source/a.md",
          filesCollapsed: false,
          leftWidth: 260,
        },
        appearance: "light",
        window: null,
      }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = { NOEMORI_TEST_WINDOW: "hidden" };
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL" && name !== "NOEMORI_TEST_WINDOW")
      environment[name] = value;
  }
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
  const session = async () =>
    JSON.parse(await readFile(join(userData, "session.json"), "utf8")).reader;
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await openLibrary(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1100, height: 720 });
    const files = page.locator(".library").getByRole("navigation", { name: "文件列表" });
    const row = (path: string) => files.locator(`[data-path="${path}"]`);
    const selected = files.locator('[role="gridcell"][aria-selected="true"]');
    await row("source/a.md").waitFor();
    await row("source/b.md").click({ modifiers: [modifier] });
    expect(await selected.count()).toBe(2);
    await row("source/a.md").click({ button: "right" });
    expect(await page.getByRole("menuitem", { name: "重命名…", exact: true }).count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(await selected.count()).toBe(2);
    await row("source/a.md").click({ button: "right" });
    await page.getByRole("menuitem", { name: "移动到…", exact: true }).click();
    const move = page.getByRole("dialog", { name: "批量移动", exact: true });
    await move.getByRole("combobox").fill("target");
    expect(await move.getByRole("option", { name: /target/ }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    const batch = page.getByRole("dialog", { name: "批量移动", exact: true });
    await batch.waitFor();
    await expect
      .poll(() => batch.getByRole("combobox").evaluate((node) => document.activeElement === node))
      .toBe(true);
    expect(await batch.innerText()).toContain("同名");
    expect(await readFile(join(vault, "source/a.md"), "utf8")).toContain("# A");
    expect(await readFile(join(vault, "source/b.md"), "utf8")).toContain("# B");
    expect(await readFile(join(vault, "target/b.md"), "utf8")).toContain("不得覆盖");
    const screenshots = process.env["NOEMORI_FILE_MANAGER_SCREENSHOTS"];
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-batch-conflict.png") });
    await rm(join(vault, "target/b.md"));
    // 冲突解除由真实文件监视传回，目标恢复可用后才能重试整批。
    await expect
      .poll(() => batch.getByRole("button", { name: "移动", exact: true }).isEnabled())
      .toBe(true);
    await batch.getByRole("button", { name: "移动", exact: true }).click();
    await batch.waitFor({ state: "hidden" });
    await row("target/a.md").waitFor();
    expect(await selected.count()).toBe(2);
    expect(await row("target/a.md").getAttribute("aria-current")).toBe("page");
    await expect
      .poll(async () => decodeURI(await readFile(join(vault, "index.md"), "utf8")))
      .toContain("target/a.md");
    expect(decodeURI(await readFile(join(vault, "index.md"), "utf8"))).toContain("target/b.md");
    await expect(stat(join(vault, "source/a.md"))).rejects.toThrow();
    expect(await readFile(join(vault, "target/a.md"), "utf8")).toMatch(/\[B\]\((?:\.\/)?b\.md\)/);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Backspace" : "Delete");
    const trash = page.getByRole("dialog", { name: "批量移到废纸篓", exact: true });
    await trash.waitFor();
    expect(await trash.innerText()).toMatch(/移到废纸篓\s+2 项/);
    await trash.getByRole("button", { name: "取消", exact: true }).click();
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "files-multiple-selection.png") });

    // 活动文档保持打开，浏览目录和滚动位置独立保存。
    await files.getByRole("button", { name: "笔记库根目录", exact: true }).click();
    await row("browse").dblclick();
    const tree = files.getByRole("treegrid");
    await tree.evaluate((node) => {
      node.scrollTop = 1050;
    });
    await expect.poll(async () => (await session()).fileTree?.scroll?.path).toMatch(/^browse\//);
    const stored = (await session()).fileTree;
    const before = await tree.evaluate((node) => node.scrollTop);
    const columns = Number(await tree.getAttribute("aria-colcount"));
    // 添加一整行，锚点文件仍在原来的视口偏移，而非保留过时的像素位置。
    await Promise.all(
      Array.from({ length: columns }, (_, i) =>
        writeFile(join(vault, `browse/000-new-${i}.md`), "# 外部新增\n"),
      ),
    );
    await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBeCloseTo(before + 30, 0);
    await expect.poll(async () => (await session()).fileTree.scroll.path).toBe(stored.scroll.path);
    const after = await tree.evaluate((node) => node.scrollTop);
    await rm(join(vault, "source"), { recursive: true });
    await expect.poll(async () => (await session()).fileTree.browse.directory).toBe("browse");
    expect(errors).toEqual([]);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("region", { name: "笔记库", exact: true }).waitFor();
    const restoredTree = reopened.getByRole("treegrid", { name: "文件与对话" });
    await expect.poll(() => restoredTree.evaluate((node) => node.scrollTop)).toBeCloseTo(after, 0);
    expect(await reopened.locator('.library [data-path="target/a.md"]').count()).toBe(0);
    expect((await session()).fileTree.scroll.path).toBe(stored.scroll.path);
    expect((await session()).documents.panes[0].currentPath).toBe("target/a.md");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
    if (screenshots)
      await reopened.screenshot({ path: join(screenshots, "files-restored-context.png") });
  } finally {
    await app.close();
  }
});
