import { sidebarComponent } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("自适应书页：图文共用左右边界，左侧目录跨尺寸保持所属文档", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-adaptive-layout-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source =
    "# 甲文档\n\n甲正文。\n\n![宽图](wide.svg)\n\n![小图](small.svg)\n\n图注 ![行内图](wide.svg)\n\n> ![引用图片](wide.svg)\n\n" +
    '<img src="wide.svg" alt="HTML 图片" width="1400" height="120">\n\n' +
    "```ts\nconst note = '甲正文';\n```\n\n" +
    `| ${Array.from({ length: 4 }, (_, index) => `列${index}`).join(" | ")} |\n` +
    `| ${Array(4).fill("---").join(" | ")} |\n` +
    `| ${Array(4).fill("完整展示的资料").join(" | ")} |\n\n` +
    "## 甲第一节\n\n" +
    "用于验证正文滚动与目录的独立位置。\n\n".repeat(40) +
    "## 甲第二节\n\n第二节正文。\n\n### 甲子节\n\n最后一节。\n";
  await Promise.all([
    writeFile(join(vault, "甲.md"), source),
    writeFile(join(vault, "乙.md"), "# 乙文档\n\n乙正文。\n\n## 乙章节\n\n乙章节正文。\n"),
    writeFile(join(vault, "无标题.md"), "没有标题的普通笔记。\n"),
    writeFile(join(vault, "短笔记.md"), "# 短笔记\n\n只有一个标题。\n"),
    writeFile(
      join(vault, "wide.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="120"><rect width="1400" height="120" fill="#839ba8"/></svg>',
    ),
    writeFile(
      join(vault, "small.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="80"><rect width="180" height="80" fill="#839ba8"/></svg>',
    ),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ reader: { vaultRoot: vault, currentPath: "甲.md", filesCollapsed: true } }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  }
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${state}`,
      "--no-sandbox",
    ],
    env: environment,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const resize = async (width: number) => {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window === undefined) throw new Error("应用窗口不存在");
        window.setContentSize(width, 900);
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    };
    const open = async (name: string, split = false) => {
      await page.keyboard.press("ControlOrMeta+o");
      const input = page.locator("dialog.picker[open]").getByRole("combobox");
      await input.fill(name);
      await input.press(split ? "ControlOrMeta+Enter" : "Enter");
      await page.waitForFunction(
        (name) =>
          document.querySelector(".topbar-document:not([hidden]) .document-name")?.textContent ===
            name &&
          [...document.querySelectorAll("section[data-pane]")].every(
            (pane) => !pane.hasAttribute("inert"),
          ),
        name,
      );
    };
    const pane = page.locator('section[data-pane="0"]');
    const leftControls = page.locator('[data-pane-tools="0"]');
    const sidebar = leftControls.locator(".outline-sidebar");
    const editor = pane.locator(".ProseMirror");
    const checkImageBounds = async () => {
      const column = await editor
        .locator(":scope > p")
        .first()
        .evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right };
        });
      const images = await editor.locator(".note-image, .html-block img").evaluateAll((nodes) =>
        nodes.map((node) => {
          const bounds = node.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right };
        }),
      );
      expect(images).toHaveLength(5);
      for (const image of images) {
        expect(image.left).toBeGreaterThanOrEqual(column.left - 0.5);
        expect(image.right).toBeLessThanOrEqual(column.right + 0.5);
      }
    };
    await editor.waitFor();
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    await resize(1440);
    await sidebarComponent(page, "目录");
    await sidebar.waitFor();
    const outlineToggle = page.getByRole("button", { name: "文章大纲", exact: true });
    await sidebarComponent(page, "文件");
    await expect.poll(() => sidebar.isVisible()).toBe(false);
    expect(await outlineToggle.getAttribute("aria-pressed")).toBe("false");
    await resize(860);
    expect(await sidebar.isVisible()).toBe(false);
    await outlineToggle.click();
    await sidebar.waitFor();
    await resize(1440);
    expect(await sidebar.isVisible()).toBe(true);
    expect(await outlineToggle.getAttribute("aria-pressed")).toBe("true");
    await expect
      .poll(() =>
        editor
          .locator(".note-image")
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1400);
    await expect
      .poll(() =>
        editor
          .getByRole("img", { name: "HTML 图片" })
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(1400);
    await expect
      .poll(() =>
        editor
          .getByRole("img", { name: "小图" })
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(180);
    const paragraphWidth = await editor
      .locator(":scope > p")
      .first()
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(paragraphWidth).toBeLessThanOrEqual(768);
    const column = await editor
      .locator(":scope > p")
      .first()
      .evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right };
      });
    const image = await editor.getByRole("img", { name: "宽图", exact: true }).evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right };
    });
    expect(image.left).toBeCloseTo(column.left, 0);
    expect(image.right).toBeCloseTo(column.right, 0);
    await checkImageBounds();
    expect(
      await editor
        .getByRole("img", { name: "小图" })
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(180);
    expect(
      await editor.locator("pre").evaluate((node) => node.getBoundingClientRect().left),
    ).toBeCloseTo(column.left, 0);
    expect(await editor.locator("table").evaluate((node) => node.clientWidth)).toBeCloseTo(
      paragraphWidth,
      0,
    );
    expect(
      await editor
        .locator("table tr")
        .first()
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBeCloseTo(paragraphWidth, 0);
    expect(
      await editor
        .getByRole("img", { name: "引用图片" })
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(paragraphWidth);
    expect(
      await editor
        .locator("p")
        .filter({ hasText: "图注" })
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(paragraphWidth);

    // 添加和撤销图注都不能改变图片的左右边界。
    await editor.getByRole("img", { name: "宽图", exact: true }).evaluate((node) => {
      const host = node.closest<HTMLElement>(".ProseMirror");
      host?.focus();
      const range = document.createRange();
      range.setStartAfter(node);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.insertText(" 图片说明");
    await checkImageBounds();
    await page.keyboard.press("ControlOrMeta+z");
    await checkImageBounds();

    expect(await pane.locator(".outline-sidebar").count()).toBe(0);
    await sidebar.getByRole("button", { name: "折叠", exact: true }).first().click();
    await expect
      .poll(() => sidebar.getByRole("button", { name: "甲第二节", exact: true }).count())
      .toBe(0);
    await sidebar.getByRole("button", { name: "展开", exact: true }).first().click();
    const sidebarTop = (await sidebar.boundingBox())!.y;
    await sidebar.getByRole("button", { name: "甲第二节", exact: true }).click();
    expect(await pane.locator(".main").evaluate((node) => node.scrollTop)).toBeGreaterThan(500);
    expect((await sidebar.boundingBox())!.y).toBe(sidebarTop);
    await page.keyboard.press("ControlOrMeta+s");
    expect(await readFile(join(vault, "甲.md"), "utf8")).toBe(source);

    await resize(860);
    await checkImageBounds();
    expect(await sidebar.isVisible()).toBe(true);
    await sidebarComponent(page, "文件");
    await expect.poll(() => sidebar.isVisible()).toBe(false);
    await resize(1440);
    expect(await outlineToggle.getAttribute("aria-pressed")).toBe("false");
    await outlineToggle.click();
    await open("乙.md", true);
    await resize(2400);
    const right = page.locator('section[data-pane="1"]');
    const rightControls = page.locator('[data-pane-tools="1"]');
    const rightOutline = rightControls.locator(".outline-sidebar");
    await rightOutline.waitFor();
    await sidebarComponent(page, "文件");
    await expect.poll(() => rightOutline.isVisible()).toBe(false);
    await pane.focus();
    expect(await sidebar.isVisible()).toBe(false);
    await sidebarComponent(page, "目录");
    expect(await sidebar.isVisible()).toBe(true);
    await right.focus();
    expect(await sidebar.isVisible()).toBe(false);
    await rightOutline.waitFor();
    expect(await rightOutline.getByRole("button", { name: "甲第二节", exact: true }).count()).toBe(
      0,
    );
    await pane.focus();
    await sidebar.getByRole("button", { name: "甲第一节", exact: true }).click();
    expect(await pane.getAttribute("class")).toContain("active");
    expect(await page.locator(".topbar-document:not([hidden]) .document-name").textContent()).toBe(
      "甲.md",
    );
    expect(await right.locator(".main").evaluate((node) => node.scrollTop)).toBe(0);
    await resize(1200);
    await checkImageBounds();
    expect(await sidebar.isVisible()).toBe(true);
    expect(await rightOutline.isVisible()).toBe(false);
    await open("无标题.md");
    expect(await sidebar.count()).toBe(0);
    expect(
      await page.getByRole("navigation", { name: "最近文件列表", exact: true }).isVisible(),
    ).toBe(true);
    await open("短笔记.md");
    expect(await pane.locator(".outline-sidebar").count()).toBe(0);
    expect(await outlineToggle.isEnabled()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
