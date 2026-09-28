import { noteAction } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("从空白笔记写作、任务交互、链接插入、查找替换和重启恢复", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-writing-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "写作.md"), ""),
    writeFile(join(vault, "参考.md"), "# 参考资料\n"),
    writeFile(join(vault, "文本.txt"), "查找目标 查找目标\n"),
    writeFile(
      join(vault, "长文.md"),
      Array.from({ length: 80 }, (_, index) =>
        index % 20 === 0 ? "定位目标" : `用于验证阅读滚动的第 ${index} 段正文。`,
      ).join("\n\n"),
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "写作.md" }),
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
    const ready = (name: string) =>
      page.waitForFunction(
        (expected) =>
          document.querySelector(".document-name")?.textContent === expected &&
          document.querySelector("section[data-pane]")?.hasAttribute("inert") === false,
        name,
      );
    const editor = page.locator(".ProseMirror");
    await ready("写作.md");
    await editor.waitFor();
    const formatting = page.getByRole("group", { name: "文本格式", exact: true });
    const formatButton = page.getByRole("button", { name: "文本格式", exact: true });

    expect(await formatting.isVisible()).toBe(false);
    expect(await page.getByRole("form", { name: "文内查找替换" }).isVisible()).toBe(false);
    await editor.click();
    await page.keyboard.type("# ");
    await page.keyboard.insertText("核心写作");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("这是");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.insertText("重点");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.insertText("内容");
    expect(await editor.innerText()).toContain("这是重点内容");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- [ ] ");
    await page.keyboard.insertText("第一项");
    await page.getByRole("checkbox", { name: "标记任务完成" }).click();
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("第二项");
    expect(await editor.locator("li").count()).toBe(2);
    expect(await editor.locator('li[data-checked="true"]').count()).toBe(1);
    expect(await editor.locator('li[data-checked="false"]').count()).toBe(1);
    await page.keyboard.press("Tab");
    expect(await editor.locator("li li").count()).toBe(1);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    await noteAction(page, "文本格式");
    await formatting.getByRole("button", { name: "链接…", exact: true }).click();
    const link = page.getByRole("dialog", { name: "插入链接" });
    await link.getByLabel("链接目标").fill("参考.md");
    await link.getByLabel("显示文字").fill("延伸阅读");
    await link.getByRole("button", { name: "插入", exact: true }).click();
    expect(await editor.locator(".wiki-link").innerText()).toBe("延伸阅读");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("ControlOrMeta+k");
    const editLink = page.getByRole("dialog", { name: "编辑链接" });
    await editLink.getByLabel("显示文字").fill("阅读资料");
    await editLink.getByRole("button", { name: "保存链接", exact: true }).click();
    expect(await editor.locator(".wiki-link").innerText()).toBe("阅读资料");
    // 在链接前只有光标时取消编辑，继续输入不得替换整段链接。
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
    await page.keyboard.press("ControlOrMeta+k");
    await editLink.waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.insertText("前");
    expect(await editor.locator(".wiki-link").count()).toBe(1);
    await page.keyboard.press("Backspace");
    expect(await editor.innerText()).toContain("重点");

    await page.keyboard.press("ControlOrMeta+f");
    const search = page.getByRole("form", { name: "文内查找替换" });
    expect(await search.getByLabel("替换为").isVisible()).toBe(false);
    await search.getByLabel("查找", { exact: true }).fill("重点");
    await search.getByRole("button", { name: "替换选项" }).click();
    await search.getByLabel("替换为").fill("关键");
    expect(await editor.innerText()).toContain("重点");
    await search.getByRole("button", { name: "全部替换" }).click();
    expect(await editor.locator("strong").innerText()).toBe("关键");
    await search.getByRole("button", { name: "关闭查找" }).click();
    await page.keyboard.press("ControlOrMeta+z");
    expect(await editor.locator("strong").innerText()).toBe("重点");
    await noteAction(page, "文本格式");
    await formatting.getByRole("button", { name: "重做", exact: true }).click();
    expect(await editor.locator("strong").innerText()).toBe("关键");
    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForFunction(
      () => document.querySelector(".save-status")?.textContent === "已保存",
    );
    const saved = await readFile(join(vault, "写作.md"), "utf8");
    expect(saved).toContain("# 核心写作");
    expect(saved).toContain("这是**关键**内容");
    expect(saved).toContain("- [x] 第一项");
    expect(saved).toContain("- [ ] 第二项");
    expect(saved).toContain("[[参考.md|阅读资料]]");
    await editor.locator(".wiki-link").click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("heading", { name: "参考资料" }).waitFor();
    await ready("参考.md");
    await page
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("treeitem", { name: "文本.txt", exact: true })
      .click();
    await ready("文本.txt");
    expect(await formatButton.isVisible()).toBe(false);
    await noteAction(page, "文内查找");
    const textSearch = page.locator(".cm-search");
    await textSearch.getByLabel("查找", { exact: true }).fill("查找目标");
    await textSearch.getByLabel("替换为").fill("已替换");
    await textSearch.getByRole("button", { name: "全部替换", exact: true }).click();
    await textSearch.getByRole("button", { name: "关闭查找", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForFunction(
      () => document.querySelector(".save-status")?.textContent === "已保存",
    );
    expect(await readFile(join(vault, "文本.txt"), "utf8")).toBe("已替换 已替换\n");
    await page
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("treeitem", { name: "写作.md", exact: true })
      .click();
    await page.getByRole("heading", { name: "核心写作" }).waitFor();
    await ready("写作.md");
    const task = editor.locator(".task-checkbox").first();
    await task.focus();
    await page.keyboard.press("Space");
    expect(await task.getAttribute("aria-checked")).toBe("false");
    await page.keyboard.press("Space");
    expect(await task.getAttribute("aria-checked")).toBe("true");
    // 用浏览器选区选中完整词，同步 selectionchange 后验证面板保留选区。
    await editor.locator("strong").evaluate((element) => {
      element.closest<HTMLElement>(".ProseMirror")?.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await noteAction(page, "文本格式");
    await formatting.getByRole("button", { name: "斜体", exact: true }).click();
    expect(await editor.locator("em").innerText()).toBe("关键");
    expect(await formatting.isVisible()).toBe(false);
    await noteAction(page, "文本格式");
    expect(
      await formatting
        .getByRole("button", { name: "斜体", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await formatting.getByRole("button", { name: "斜体", exact: true }).click();
    expect(await editor.locator("em").count()).toBe(0);
    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForFunction(
      () => document.querySelector(".save-status")?.textContent === "已保存",
    );
    await editor.locator(":scope > p").first().click();
    const screenshots = process.env.NOUS_WRITING_SCREENSHOTS;
    if (screenshots) await page.screenshot({ path: join(screenshots, "writing-wide.png") });
    await page.setViewportSize({ width: 480, height: 800 });
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    expect(
      await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (process.env.NOUS_WRITING_SCREENSHOT)
      await page.screenshot({ path: process.env.NOUS_WRITING_SCREENSHOT });
    if (screenshots) await page.screenshot({ path: join(screenshots, "writing-narrow.png") });
    // 原生弹层支持键盘进入与 Escape 返回入口，不能让隐藏控件挤占正文。
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    await formatButton.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    expect(
      await formatting
        .getByLabel("段落格式")
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    if (screenshots) await page.screenshot({ path: join(screenshots, "writing-formatting.png") });
    await page.keyboard.press("Escape");
    expect(await formatting.isVisible()).toBe(false);
    await noteAction(page, "文本格式");
    expect(await formatting.isVisible()).toBe(true);
    await page.keyboard.press("ControlOrMeta+f");
    await search.waitFor();
    expect(await formatting.isVisible()).toBe(false);
    await search.getByLabel("查找", { exact: true }).fill("关键");
    await search.getByRole("button", { name: "下一处" }).click();
    await page.keyboard.press("ControlOrMeta+f");
    expect(
      await search
        .getByLabel("查找", { exact: true })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await search.getByRole("button", { name: "替换选项" }).click();
    if (screenshots) await page.screenshot({ path: join(screenshots, "writing-search.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    if (screenshots) await page.screenshot({ path: join(screenshots, "writing-search-dark.png") });
    await search.getByRole("button", { name: "替换选项" }).focus();
    await page.keyboard.press("Escape");
    expect(await search.isVisible()).toBe(false);
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("ControlOrMeta+k");
    if (screenshots) await page.screenshot({ path: join(screenshots, "writing-link-dark.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    const files = page.getByRole("navigation", { name: "文件列表" });
    await files.getByRole("treeitem", { name: "长文.md", exact: true }).click();
    await ready("长文.md");
    expect(await search.isVisible()).toBe(false);
    await expect.poll(() => files.isVisible()).toBe(false);
    await noteAction(page, "文内查找");
    await search.getByLabel("查找", { exact: true }).fill("定位目标");
    const searchStatus = search.getByRole("status");
    await expect.poll(() => searchStatus.textContent()).toBe("共 4 处");
    for (let index = 0; index < 3; index++) {
      await search.getByRole("button", { name: "下一处" }).click();
      await expect.poll(() => searchStatus.textContent()).toBe(`第 ${index + 1} 处，共 4 处`);
    }
    await search.getByRole("button", { name: "替换选项" }).click();
    await search.getByRole("button", { name: "上一处" }).click();
    await expect.poll(() => searchStatus.textContent()).toBe("第 2 处，共 4 处");
    expect(
      await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const resultBounds = await editor.locator(".ProseMirror-active-search-match").boundingBox();
    const searchBounds = await search.boundingBox();
    expect(resultBounds).not.toBeNull();
    expect(searchBounds).not.toBeNull();
    expect(resultBounds!.y).toBeGreaterThanOrEqual(searchBounds!.y + searchBounds!.height);
    expect(resultBounds!.y + resultBounds!.height).toBeLessThanOrEqual(800);
    if (screenshots) await page.screenshot({ path: join(screenshots, "writing-long-search.png") });
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    await files.getByRole("treeitem", { name: "写作.md", exact: true }).click();
    await ready("写作.md");
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("heading", { name: "核心写作" }).waitFor();
    expect(await reopened.locator(".ProseMirror strong").innerText()).toBe("关键");
    expect(await readFile(join(vault, "写作.md"), "utf8")).toBe(saved);
  } finally {
    await app.close();
  }
});
