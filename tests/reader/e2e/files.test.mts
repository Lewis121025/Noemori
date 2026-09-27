import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("文件树支持搜索定位、新建、重名保护、键盘重命名、目录移动与拖拽", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-files-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([
    mkdir(join(vault, "项目/研究"), { recursive: true }),
    mkdir(join(vault, "项目/空文件夹"), { recursive: true }),
    mkdir(join(vault, "归档"), { recursive: true }),
    mkdir(join(vault, "收件箱"), { recursive: true }),
    mkdir(userData),
  ]);
  await Promise.all([
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const files = page.getByRole("navigation", { name: "文件列表" });
    const row = (path: string) => files.locator(`[data-path="${path}"]`);
    const active = (path: string) =>
      page.waitForFunction(
        (value) =>
          document.querySelector(".file.active")?.getAttribute("data-path") === value &&
          !document.querySelector(".panes")?.hasAttribute("inert"),
        path,
      );
    const dialog = page.locator(".entry-dialog");
    const contextAction = async (path: string, label: string) => {
      await row(path).click({ button: "right" });
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    const rootAction = async (label: string) => {
      await files.getByRole("button", { name: "文件管理", exact: true }).click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    const nameAndSubmit = async (name: string, label: string) => {
      await dialog.locator("input").fill(name);
      await dialog.getByRole("button", { name: label, exact: true }).click();
    };
    const screenshots = process.env.NOUS_FILE_MANAGER_SCREENSHOTS;
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
    await files.getByRole("button", { name: "新建笔记", exact: true }).click();
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
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
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
    await row("项目/研究/笔记.md").click();
    await active("项目/研究/笔记.md");
    expect(await readFile(join(vault, "资料/入门.md"), "utf8")).toContain("创建后的内容");

    await row("项目/空文件夹").click();
    await row("项目").focus();
    await page.keyboard.press("F2");
    expect(await dialog.getByRole("button", { name: "重命名", exact: true }).isDisabled()).toBe(
      true,
    );
    await nameAndSubmit("计划", "重命名");
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
    await dialog.getByLabel("目标文件夹").selectOption("资料");
    expect(await dialog.locator('option[value="计划/研究"]').count()).toBe(0);
    if (screenshots) await page.screenshot({ path: join(screenshots, "files-move-dialog.png") });
    await dialog.getByRole("button", { name: "移动", exact: true }).click();
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

    await row("资料/入门.md").click();
    await active("资料/入门.md");
    await row("资料/入门.md").dragTo(row("收件箱"));
    await active("收件箱/入门.md");
    expect(await row("收件箱/入门.md").evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
    expect(await readFile(join(vault, "收件箱/入门.md"), "utf8")).toContain("创建后的内容");
    await row("收件箱/入门.md").focus();
    await page.keyboard.press("F2");
    await nameAndSubmit("完成.md", "重命名");
    await active("收件箱/完成.md");
    await contextAction("收件箱/完成.md", "移到废纸篓…");
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
    await resize.focus();
    await page.keyboard.press("Tab");
    expect(
      await page.locator(".ProseMirror").evaluate((node) => node.contains(document.activeElement)),
    ).toBe(false);
    await search.focus();
    await search.fill("完成");
    await search.press("Escape");
    expect(await search.inputValue()).toBe("");
    expect(await files.isVisible()).toBe(true);
    await search.press("Escape");
    expect(await files.isVisible()).toBe(false);
    const filesToggle = page.getByRole("button", { name: "显示或隐藏文件栏" });
    expect(await filesToggle.evaluate((node) => node === document.activeElement)).toBe(true);
    for (const shortcut of [true, false]) {
      await filesToggle.click();
      if (shortcut) {
        await search.focus();
        await page.keyboard.press(`${modifier}+f`);
      } else await page.getByRole("button", { name: "文内查找", exact: true }).click();
      expect(await files.isVisible()).toBe(false);
      const find = page.getByRole("form", { name: "文内查找替换" });
      expect(
        await find
          .getByLabel("查找", { exact: true })
          .evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press("Escape");
    }
    await filesToggle.click();
    await page.getByRole("button", { name: "文本格式", exact: true }).click();
    expect(await files.isVisible()).toBe(false);
    expect(await page.getByRole("group", { name: "文本格式", exact: true }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await filesToggle.click();
    await page.getByRole("button", { name: "收起文件栏", exact: true }).click();
    expect(await page.getByRole("complementary", { name: "文件栏" }).isVisible()).toBe(false);
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    await row("收件箱/完成.md").click();
    await page.getByRole("complementary", { name: "文件栏" }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    await search.fill("没有这个条目");
    expect(await files.getByText("没有匹配的文件", { exact: true }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.locator('.file.active[data-path="收件箱/完成.md"]').waitFor();
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
    const firstNote = empty.getByRole("dialog", { name: "新建笔记", exact: true });
    expect(await firstNote.locator("input").inputValue()).toBe("未命名.md");
    await firstNote.getByRole("button", { name: "创建", exact: true }).click();
    await empty.locator('.file.active[data-path="未命名.md"]').waitFor();
    await empty.keyboard.insertText("第一篇笔记直接开始写作。");
    await empty.keyboard.press(`${modifier}+s`);
    await expect
      .poll(() => readFile(join(vault, "未命名.md"), "utf8"))
      .toContain("第一篇笔记直接开始写作。");

    // 窄窗口中新建也应让出正文，避免光标已经进入编辑器却被文件栏遮住。
    await empty.setViewportSize({ width: 600, height: 700 });
    await empty
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("button", { name: "新建笔记", exact: true })
      .click();
    expect(await firstNote.locator("input").inputValue()).toBe("未命名 2.md");
    await firstNote.getByRole("button", { name: "创建", exact: true }).click();
    await firstNote.waitFor({ state: "hidden" });
    expect(await empty.getByRole("complementary", { name: "文件栏" }).isVisible()).toBe(false);
    expect(
      await empty.locator(".ProseMirror").evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
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
