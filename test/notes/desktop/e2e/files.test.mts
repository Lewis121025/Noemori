import { noteAction, openLibrary } from "../support/workspace-actions";
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
    await files.locator('[data-path="archive"]').waitFor();
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

test("万条目录深处的行高与隐藏恢复保持稳定", async (t) => {
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
    const tree = page.getByRole("tree", { name: "笔记库目录" });
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
    await page.getByRole("button", { name: "阅读与写作", exact: true }).click();
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
    await search.fill("笔记500");
    await search.press("ArrowDown");
    await page.keyboard.press(`${modifier}+ArrowDown`);
    expect(await row("笔记5000.md").evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await row("笔记500.md").getAttribute("aria-selected")).toBe("true");
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
    expect(await trash.isVisible()).toBe(false);
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
    expect(await row("笔记5002.md").getAttribute("aria-selected")).toBe("true");
  } finally {
    await app.close();
  }
});

test("文件树支持搜索定位、新建、重名保护、键盘重命名、目录移动与拖拽", async (t) => {
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
    const active = (path: string) =>
      page.waitForFunction(
        (value) =>
          document.querySelector(".file.active")?.getAttribute("data-path") === value &&
          !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        path,
      );
    const dialog = page.locator(".entry-dialog");
    const contextAction = async (path: string, label: string) => {
      await openLibrary(page);
      await row(path).click({ button: "right" });
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    const rootAction = async (label: string) => {
      await openLibrary(page);
      await files.getByRole("button", { name: "文件管理", exact: true }).click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    const nameAndSubmit = async (name: string, label: string) => {
      await dialog.locator("input").fill(name);
      await dialog.getByRole("button", { name: label, exact: true }).click();
    };
    const screenshots = process.env.NOEMORI_FILE_MANAGER_SCREENSHOTS;
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    await active("项目/研究/笔记.md");
    expect(await row("项目").getAttribute("aria-expanded")).toBe("true");
    expect(await row("项目/研究/笔记.md").getAttribute("aria-level")).toBe("3");
    expect(await row("项目/空文件夹").isVisible()).toBe(true);
    await row("归档").click();
    expect(await files.getByRole("treeitem", { name: "笔记.md", exact: true }).count()).toBe(2);
    await row("项目").click();
    expect(await row("项目/研究/笔记.md").count()).toBe(0);
    const search = files.getByRole("searchbox");
    await search.fill("研究/笔记");
    expect(await row("项目/研究/笔记.md").isVisible()).toBe(true);
    expect(await row("归档").count()).toBe(0);
    await search.press("Escape");
    expect(await search.inputValue()).toBe("");
    expect(await row("项目/研究/笔记.md").count()).toBe(0);
    await rootAction("定位当前文件");
    expect(await row("项目/研究/笔记.md").evaluate((node) => document.activeElement === node)).toBe(
      true,
    );
    await page
      .locator(".library-heading")
      .getByRole("button", { name: "新建笔记", exact: true })
      .click();
    expect(await dialog.locator(".hint").innerText()).toBe("位置：项目/研究");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await row("项目/研究/笔记.md").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await row("项目/研究").evaluate((node) => document.activeElement === node)).toBe(true);
    expect(await row("项目/研究").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("ArrowRight");
    expect(await row("项目/研究/笔记.md").evaluate((node) => document.activeElement === node)).toBe(
      true,
    );
    await page.keyboard.press(`${modifier}+n`);
    expect(await dialog.locator("input").inputValue()).toBe("未命名 2.md");
    await dialog.locator("input").fill("快捷键不会覆盖正在输入的名称");
    await page.keyboard.press(`${modifier}+n`);
    expect(await dialog.locator("input").inputValue()).toBe("快捷键不会覆盖正在输入的名称");
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${modifier}+Shift+n`);
    expect(await dialog.getByRole("heading").innerText()).toBe("新建文件夹");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "阅读与写作", exact: true }).click();
    await page.keyboard.press(`${modifier}+Shift+f`);
    expect(await search.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await row("归档/笔记.md").isVisible()).toBe(true);
    expect(await row("项目/研究/笔记.md").isVisible()).toBe(true);
    await search.fill("找不到的笔记");
    await files.getByRole("button", { name: "查看全部文件", exact: true }).click();
    expect(await search.inputValue()).toBe("");
    await search.press("ArrowDown");
    expect(await row("归档").evaluate((node) => node === document.activeElement)).toBe(true);
    await row("归档/笔记.md").click({ button: "right" });
    await page.keyboard.press("Escape");
    expect(await row("归档/笔记.md").evaluate((node) => node === document.activeElement)).toBe(
      true,
    );

    await page.getByRole("button", { name: "阅读与写作", exact: true }).click();
    const resize = page.getByRole("separator", { name: "调整侧栏宽度" });
    await resize.focus();
    await resize.press("ArrowRight");
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(userData, "session.json"), "utf8")).reader.leftWidth,
      )
      .toBe(270);
    await resize.dblclick();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(userData, "session.json"), "utf8")).reader.leftWidth,
      )
      .toBe(232);
    const handle = await resize.boundingBox();
    if (!handle) throw new Error("侧栏分隔条不可见");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 28, handle.y + 80, { steps: 6 });
    expect(await resize.getAttribute("aria-valuenow")).toBe("260");
    expect(
      JSON.parse(await readFile(join(userData, "session.json"), "utf8")).reader.leftWidth,
    ).toBe(232);
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(userData, "session.json"), "utf8")).reader.leftWidth,
      )
      .toBe(260);
    await rootAction("定位当前文件");
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-light.png") });

    for (const label of ["浏览标签", "书签"]) {
      await files.getByRole("button", { name: label, exact: true }).click();
      await files.getByRole("tree").waitFor({ state: "detached" });
      await rootAction("定位当前文件");
      expect(
        await row("项目/研究/笔记.md").evaluate((node) => node === document.activeElement),
      ).toBe(true);
    }
    await search.fill("研究");
    await search.press("Enter");
    await files.getByRole("region", { name: "全文搜索结果" }).waitFor();
    await rootAction("定位当前文件");
    expect(await row("项目/研究/笔记.md").evaluate((node) => node === document.activeElement)).toBe(
      true,
    );

    await row("归档/浏览").click();
    const tree = files.getByRole("tree");
    await tree.evaluate((node) => {
      node.scrollTop = 900;
    });
    await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(900);
    expect(await tree.getByRole("treeitem").count()).toBeLessThan(100);
    for (const label of ["浏览标签", "书签"]) {
      await files.getByRole("button", { name: label, exact: true }).click();
      await tree.waitFor({ state: "detached" });
      await files.getByRole("button", { name: label, exact: true }).click();
      await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(900);
    }
    for (const fullText of [false, true]) {
      await search.fill("研究/笔记");
      await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(0);
      if (fullText) {
        await search.press("Enter");
        await files.getByRole("region", { name: "全文搜索结果" }).waitFor();
      }
      await files.getByRole("button", { name: "清除搜索", exact: true }).click();
      await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(900);
    }
    await rootAction("收起所有文件夹");
    await rootAction("定位当前文件");

    await rootAction("新建文件夹");
    await nameAndSubmit("资料", "创建");
    await dialog.waitFor({ state: "hidden" });
    expect((await stat(join(vault, "资料"))).isDirectory()).toBe(true);
    expect(await row("资料").getAttribute("aria-selected")).toBe("true");
    expect(await row("资料").evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press(`${modifier}+n`);
    expect(await dialog.locator(".hint").innerText()).toBe("位置：资料");
    await page.keyboard.press("Escape");
    await rootAction("新建文件夹");
    await dialog.locator("input").fill("资料");
    await dialog.getByRole("alert").waitFor();
    expect(await dialog.getByRole("button", { name: "创建", exact: true }).isDisabled()).toBe(true);
    expect(await dialog.isVisible()).toBe(true);
    await dialog.locator("input").fill("其他资料");
    expect(await dialog.getByRole("alert").count()).toBe(0);
    expect(await dialog.getByRole("button", { name: "创建", exact: true }).isEnabled()).toBe(true);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();

    await contextAction("资料", "新建笔记");
    await nameAndSubmit("入门", "创建");
    await active("资料/入门.md");
    expect(
      await page.locator(".ProseMirror").evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.insertText("创建后的内容会先保存，再移动。 ");
    await openLibrary(page);
    await row("项目/研究/笔记.md").dblclick();
    await active("项目/研究/笔记.md");
    expect(await readFile(join(vault, "资料/入门.md"), "utf8")).toContain("创建后的内容");

    await openLibrary(page);
    await row("项目/空文件夹").click();
    await row("项目").focus();
    // 焦点可独立于选择移动；先选中父目录，再通过 F2 改名。
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("F2");
    const renameFolder = files.getByRole("textbox", { name: "重命名文件夹", exact: true });
    expect(await renameFolder.inputValue()).toBe("项目");
    expect(await dialog.isVisible()).toBe(false);
    await renameFolder.fill("计划");
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-inline-rename.png") });
    await renameFolder.press("Enter");
    await active("计划/研究/笔记.md");
    expect(await row("计划").getAttribute("aria-selected")).toBe("true");
    expect(await row("计划").evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await row("计划/空文件夹").getAttribute("aria-expanded")).toBe("true");
    expect((await stat(join(vault, "计划/空文件夹"))).isDirectory()).toBe(true);
    await expect
      .poll(async () => decodeURI(await readFile(join(vault, "索引.md"), "utf8")))
      .toContain("计划/研究/笔记.md");
    await contextAction("计划", "移动到…");
    expect(await dialog.getByRole("button", { name: "移动", exact: true }).isDisabled()).toBe(true);
    const destination = dialog.getByRole("combobox", { name: "目标文件夹" });
    expect(await destination.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await dialog.getByRole("option", { name: "计划/研究", exact: true }).count()).toBe(0);
    await destination.fill("不存在");
    expect(await dialog.getByRole("button", { name: "移动", exact: true }).isDisabled()).toBe(true);
    await destination.fill("");
    await dialog.getByRole("option", { name: "资料", exact: true }).click();
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-move-dialog.png") });
    await destination.fill("资料");
    expect(await dialog.innerText()).toContain("移动后：资料/计划");
    await destination.press("Enter");
    await active("资料/计划/研究/笔记.md");
    expect(await row("资料/计划").getAttribute("aria-selected")).toBe("true");
    expect(await row("资料/计划").evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await row("资料/计划/空文件夹").getAttribute("aria-expanded")).toBe("true");
    expect(decodeURI(await readFile(join(vault, "资料/计划/研究/笔记.md"), "utf8"))).toContain(
      "../../../索引.md",
    );
    expect(decodeURI(await readFile(join(vault, "索引.md"), "utf8"))).toContain(
      "资料/计划/研究/笔记.md",
    );
    expect((await stat(join(vault, "资料/计划/空文件夹"))).isDirectory()).toBe(true);

    await row("资料/入门.md").dblclick();
    await active("资料/入门.md");
    await openLibrary(page);
    await row("资料/入门.md").dragTo(row("收件箱"));
    await active("收件箱/入门.md");
    expect(await row("收件箱/入门.md").evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
    expect(await readFile(join(vault, "收件箱/入门.md"), "utf8")).toContain("创建后的内容");
    await row("收件箱/入门.md").focus();
    await page.keyboard.press("F2");
    const renameFile = files.getByRole("textbox", { name: "重命名文件", exact: true });
    expect(
      await renameFile.evaluate((node: HTMLInputElement) =>
        node.value.slice(node.selectionStart ?? 0, node.selectionEnd ?? 0),
      ),
    ).toBe("入门");
    await renameFile.fill("完成.md");
    await renameFile.press("Enter");
    await active("收件箱/完成.md");
    await row("收件箱/完成.md").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Backspace" : "Delete");
    expect(await dialog.innerText()).toContain("可以从系统废纸篓恢复");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(await readFile(join(vault, "收件箱/完成.md"), "utf8")).toContain("创建后的内容");
    const reader = JSON.parse(await readFile(join(userData, "session.json"), "utf8")).reader;
    // 会话按分栏保存；活动栏路径在 documents 里，顶层不再写 currentPath。
    expect(reader.documents.panes[reader.documents.active].currentPath).toBe("收件箱/完成.md");

    await page.getByRole("button", { name: "切换笔记库" }).click();
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await row("收件箱/完成.md").click({ button: "right" });
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-dark-menu.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 640, height: 480 });
    await contextAction("收件箱/完成.md", "移动到…");
    await dialog.getByRole("combobox", { name: "目标文件夹" }).fill("资料/计划/研究");
    const moveBounds = await dialog.boundingBox();
    expect(moveBounds).not.toBeNull();
    expect(moveBounds!.y).toBeGreaterThanOrEqual(0);
    expect(moveBounds!.y + moveBounds!.height).toBeLessThanOrEqual(480);
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "files-move-dark-narrow.png") });
    await page.keyboard.press("Escape");
    expect(await row("收件箱/完成.md").evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
    await page.keyboard.press("F2");
    await renameFile.fill("../错误.md");
    expect(await files.getByRole("alert").isVisible()).toBe(true);
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "files-inline-error-dark.png") });
    await renameFile.press("Escape");
    expect(await files.isVisible()).toBe(true);
    expect(await row("收件箱/完成.md").evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
    await page.setViewportSize({ width: 600, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-narrow.png") });
    await row("收件箱/完成.md").click({ button: "right" });
    const menuBounds = await page.getByRole("menu", { name: "文件操作" }).boundingBox();
    expect(menuBounds).not.toBeNull();
    expect(menuBounds!.x).toBeGreaterThanOrEqual(8);
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(592);
    expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(692);
    await page.keyboard.press("Escape");
    await search.focus();
    await search.fill("完成");
    await files.getByRole("button", { name: "清除搜索", exact: true }).click();
    expect(await files.isVisible()).toBe(true);
    await page.getByRole("button", { name: "阅读与写作", exact: true }).click();
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    const quickFiles = page.locator(".quick-navigation");
    if (await quickFiles.isVisible())
      await page.getByRole("button", { name: "收起文件栏", exact: true }).click();
    await noteAction(page, "文内查找");
    await page.getByRole("form", { name: "文内查找替换" }).waitFor();
    await page.keyboard.press("Escape");
    await page
      .locator(".pane-column.active")
      .getByRole("toolbar", { name: "编辑工具栏", exact: true })
      .waitFor();
    expect(
      await page
        .locator(".pane-column.active")
        .getByRole("toolbar", { name: "编辑工具栏", exact: true })
        .isVisible(),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    await quickFiles.locator('[data-path="收件箱/完成.md"]').click();
    await page.getByRole("complementary", { name: "文件栏" }).waitFor({ state: "hidden" });
    expect(errors).toEqual([]);
    await assertHidden();
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.locator(".ProseMirror").waitFor();
    expect(await reopened.locator(".ProseMirror").innerText()).toContain("创建后的内容");
    await app.close();
    // 空笔记库也应能从正文区域直接开始，不要求用户先了解文件栏。
    await rm(vault, { recursive: true });
    await mkdir(vault);
    app = await launch();
    const empty = await app.firstWindow();
    await empty.getByRole("heading", { name: "从第一篇笔记开始", exact: true }).waitFor();
    await empty.setViewportSize({ width: 1100, height: 720 });
    if (screenshots) await empty.screenshot({ path: join(screenshots, "files-empty.png") });
    await empty.locator(".welcome").getByRole("button", { name: "新建笔记", exact: true }).click();
    await empty.locator(".ProseMirror").waitFor();
    await expect
      .poll(() =>
        empty.locator(".ProseMirror").evaluate((node) => node.contains(document.activeElement)),
      )
      .toBe(true);
    await empty.keyboard.insertText("第一篇笔记直接开始写作。");
    await empty.keyboard.press(`${modifier}+s`);
    await expect
      .poll(() => readFile(join(vault, "未命名.md"), "utf8"))
      .toContain("第一篇笔记直接开始写作。");

    // 窄窗口中新建也应让出正文，避免光标已经进入编辑器却被文件栏遮住。
    await empty.setViewportSize({ width: 600, height: 700 });
    await empty.getByRole("button", { name: "新建笔记", exact: true }).click();
    await expect.poll(() => empty.locator(".document-name").textContent()).toBe("未命名 2.md");
    expect(await empty.getByRole("complementary", { name: "文件栏" }).isVisible()).toBe(false);
    await expect
      .poll(() =>
        empty.locator(".ProseMirror").evaluate((node) => node.contains(document.activeElement)),
      )
      .toBe(true);
    await empty.keyboard.insertText("小窗口也能直接写下想法。");
    await empty.keyboard.press(`${modifier}+s`);
    await expect
      .poll(() => readFile(join(vault, "未命名 2.md"), "utf8"))
      .toContain("小窗口也能直接写下想法。");
    if (screenshots)
      await empty.screenshot({ path: join(screenshots, "files-writing-narrow.png") });
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
    const selected = files.locator('[role="treeitem"][aria-selected="true"]');
    await row("source/a.md").waitFor();
    await row("source/b.md").click({ modifiers: [modifier] });
    expect(await selected.count()).toBe(2);
    await row("source/a.md").click({ button: "right" });
    expect(await page.getByRole("menuitem", { name: "重命名…", exact: true }).count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(await selected.count()).toBe(2);
    await row("source/a.md").dragTo(row("target"));
    const batch = page.getByRole("dialog", { name: "批量移动", exact: true });
    await batch.waitFor();
    await expect
      .poll(() => batch.getByRole("combobox").evaluate((node) => document.activeElement === node))
      .toBe(true);
    expect(await batch.getByRole("alert").innerText()).toContain("同名");
    expect(await readFile(join(vault, "source/a.md"), "utf8")).toContain("# A");
    expect(await readFile(join(vault, "source/b.md"), "utf8")).toContain("# B");
    expect(await readFile(join(vault, "target/b.md"), "utf8")).toContain("不得覆盖");
    const screenshots = process.env["NOEMORI_FILE_MANAGER_SCREENSHOTS"];
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-batch-conflict.png") });
    await rm(join(vault, "target/b.md"));
    // 冲突解除由真实文件监视传回，目标恢复可用后才能重试整批。
    await expect
      .poll(() => batch.getByRole("button", { name: "重试剩余项", exact: true }).isEnabled())
      .toBe(true);
    await batch.getByRole("button", { name: "重试剩余项", exact: true }).click();
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

    // 活动文档仍打开，但用户主动收起它的父目录并浏览另一处；重启不应自动展开。
    await row("target").click();
    await row("source").click();
    await row("browse").click({ modifiers: [modifier] });
    await page.keyboard.press("ArrowRight");
    const tree = files.getByRole("tree");
    await tree.evaluate((node) => {
      node.scrollTop = 1050;
    });
    await expect.poll(async () => (await session()).fileTree?.scroll?.path).toMatch(/^browse\//);
    const stored = (await session()).fileTree;
    const before = await tree.evaluate((node) => node.scrollTop);
    await writeFile(join(vault, "browse/000-new.md"), "# 外部新增\n");
    await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBeGreaterThan(before + 30);
    await expect.poll(async () => (await session()).fileTree.scroll.path).toBe(stored.scroll.path);
    const after = await tree.evaluate((node) => node.scrollTop);
    expect(after).toBeCloseTo(before + 35.2, 0);
    await rm(join(vault, "source"), { recursive: true });
    await expect
      .poll(async () => (await session()).fileTree.selected, { timeout: 5000 })
      .toEqual(["browse"]);
    await expect
      .poll(async () => (await session()).fileTree.expanded.includes("target"))
      .toBe(false);
    expect(errors).toEqual([]);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("region", { name: "资料管理", exact: true }).waitFor();
    const restoredTree = reopened.getByRole("tree", { name: "笔记库目录" });
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
