import { noteAction } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("连续阅读与编辑时，链接不误跳转、源码不抢焦点且能用键盘返回正文", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-continuous-editing-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const source =
    "# 连续编辑\n\n前文 [链接文字](参考.md) 和 [[参考.md|内部资料]] 后文。\n\n公式前 $x+y$ 公式后。\n\n$$\na+b=c\n$$\n\n<div>HTML 内容</div>\n\n**继续**写作。\n";
  await Promise.all([
    writeFile(join(vault, "笔记.md"), source),
    writeFile(join(vault, "参考.md"), "# 参考资料\n"),
    writeFile(
      join(vault, "长文.md"),
      "# 选区定位\n\n第一行目标内容。\n\n" +
        Array.from({ length: 80 }, (_, index) => `阅读正文第 ${index + 1} 段。`).join("\n\n"),
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "笔记.md" }),
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
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    const quickFormat = page.getByRole("toolbar", { name: "选区格式", exact: true });
    await editor.waitFor();
    expect(await quickFormat.isVisible()).toBe(false);
    await page.locator(".math-inline mjx-container").waitFor();
    const screenshots = process.env.NOUS_INTERACTION_SCREENSHOTS;
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "continuous-reading.png"), scale: "css" });
    const link = editor.locator('a[href="参考.md"]');
    await link.click();
    expect(await page.locator(".document-name").innerText()).toBe("笔记.md");
    await page.keyboard.insertText("改");
    expect(await link.innerText()).toContain("改");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await link.innerText()).toBe("链接文字");

    const start = await editor.locator(":scope > p").nth(0).boundingBox();
    const end = await editor.locator(":scope > p").nth(1).boundingBox();
    if (start === null || end === null) throw new Error("正文不可见");
    // 拖拽期间 ProseMirror 推迟选区回写，mouseup 后经 setTimeout 把内部状态
    // 写回 DOM；合成拖拽的事件间隔远小于真人，这次回写可能与最后一次
    // selectionchange 竞态，把 DOM 选区倒回中途位置（本用例历史偶发失败源）。
    // 按真人节奏停顿等待同步落定；仍偶发竞态时整体重试拖拽直至选区正确。
    await expect
      .poll(
        async () => {
          await page.mouse.move(start.x + 2, start.y + start.height / 2);
          await page.mouse.down();
          await page.mouse.move(end.x + end.width - 2, end.y + end.height / 2, { steps: 12 });
          expect(await quickFormat.isVisible()).toBe(false);
          await page.waitForTimeout(100);
          await page.mouse.up();
          await page.waitForTimeout(50);
          return page.evaluate(() => window.getSelection()?.toString() ?? "");
        },
        { timeout: 10000, interval: 100 },
      )
      .toContain("链接文字");
    expect(await page.locator(".document-name").innerText()).toBe("笔记.md");
    expect(await editor.locator(".math-source").count()).toBe(0);

    const wiki = editor.locator(".wiki-link");
    await wiki.click();
    expect(await page.locator(".document-name").innerText()).toBe("笔记.md");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "编辑链接" }).waitFor();
    await page.keyboard.press("Escape");

    const math = editor.locator(".math-inline");
    await math.click();
    await expect.poll(() => quickFormat.isVisible()).toBe(false);
    expect(await editor.locator(".math-source").count()).toBe(0);
    expect(await math.getAttribute("class")).toContain("ProseMirror-selectednode");
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "formula-selected.png"), scale: "css" });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.insertText("接着");
    expect(await math.locator("mjx-container").count()).toBe(1);
    expect(await editor.innerText()).toContain("接着 公式后");
    await page.keyboard.press("ControlOrMeta+z");

    await math.dblclick();
    const inlineSource = page.getByRole("textbox", { name: "行内公式源码" });
    await inlineSource.waitFor();
    await inlineSource.fill("x+y+z");
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "formula-editing.png"), scale: "css" });
    await page.setViewportSize({ width: 480, height: 800 });
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    await inlineSource.fill("x+".repeat(100) + "y");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const inputBounds = await inlineSource.boundingBox();
    expect(inputBounds).not.toBeNull();
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(480);
    await page.emulateMedia({ colorScheme: "dark" });
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "formula-narrow-dark.png"), scale: "css" });
    await inlineSource.fill("x+y+z");
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    await inlineSource.focus();
    await page.keyboard.press("Escape");
    expect(await inlineSource.count()).toBe(0);
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await inlineSource.waitFor();
    expect(await inlineSource.inputValue()).toBe("x+y+z");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    expect(await inlineSource.count()).toBe(0);
    await page.keyboard.insertText("继续");
    expect(await editor.innerText()).toContain("继续 公式后");

    const block = editor.locator(".math-block");
    await block.click();
    expect(await editor.locator(".math-source").count()).toBe(0);
    await page.keyboard.press("Enter");
    const blockSource = page.getByRole("textbox", { name: "块级公式源码" });
    await blockSource.waitFor();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("d=e");
    expect(await blockSource.inputValue()).toContain("\nd=e");
    await page.keyboard.press("Escape");
    expect(await blockSource.count()).toBe(0);

    const html = editor.locator(".html-block");
    await html.click();
    expect(await editor.locator(".html-source").count()).toBe(0);
    await page.keyboard.press("Enter");
    const htmlSource = page.getByRole("textbox", { name: "块级HTML源码" });
    await htmlSource.waitFor();
    await htmlSource.fill("<div>新的内容</div>");
    await page.keyboard.press("Escape");
    expect(await html.innerText()).toBe("新的内容");

    // 正常键盘选词后设置格式，格式控件不能吞掉选区或把输入位置带回文首。
    const paragraph = editor.locator(":scope > p").last();
    expect(await paragraph.innerText()).toBe("继续写作。");
    await paragraph.click();
    await expect.poll(() => editor.locator(".ProseMirror-selectednode").count()).toBe(0);
    await page.keyboard.press("End");
    for (let index = 0; index < 5; index++) await page.keyboard.press("Shift+ArrowLeft");
    const selection = await page.evaluate(() => window.getSelection()?.toString());
    expect(selection).toBe("继续写作。");
    await quickFormat.waitFor({ timeout: 3000 });
    // 浏览器选区先于 selectionchange 进入编辑器；等待对应格式状态，而非上一选区已可见的工具条。
    await expect
      .poll(() =>
        quickFormat.getByRole("button", { name: "加粗", exact: true }).getAttribute("aria-pressed"),
      )
      .toBe("mixed");
    if (screenshots)
      await page.screenshot({
        path: join(screenshots, "selection-formatting-mixed.png"),
        scale: "css",
      });
    await quickFormat.getByRole("button", { name: "加粗", exact: true }).click();
    expect(await paragraph.locator("strong").innerText()).toBe(selection);
    expect(await quickFormat.isVisible()).toBe(true);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
    await quickFormat.getByRole("button", { name: "斜体", exact: true }).click();
    expect(await paragraph.locator("em").innerText()).toBe(selection);
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "selection-formatting.png"), scale: "css" });
    expect(
      await quickFormat
        .getByRole("button", { name: "加粗", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await quickFormat.getByRole("button", { name: "斜体", exact: true }).click();
    expect(await paragraph.locator("em").count()).toBe(0);
    await page.keyboard.press("Alt+F10");
    expect(
      await quickFormat
        .getByRole("button", { name: "加粗", exact: true })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    expect(await paragraph.locator("em").innerText()).toBe(selection);
    await page.keyboard.press("Enter");
    expect(await paragraph.locator("em").count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(await quickFormat.isVisible()).toBe(false);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
    await page.keyboard.press("Alt+F10");
    await quickFormat.getByRole("button", { name: "链接…", exact: true }).click();
    await page.getByRole("dialog", { name: "插入链接" }).waitFor();
    expect(await quickFormat.isVisible()).toBe(false);
    await page.keyboard.press("Escape");
    await quickFormat.waitFor();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
    await noteAction(page, "文本格式");
    await expect.poll(() => quickFormat.isVisible()).toBe(false);
    await page.getByRole("combobox", { name: "段落格式" }).waitFor();
    await page.keyboard.press("Escape");
    await editor.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.insertText("后续输入");
    expect(await paragraph.innerText()).toBe("继续写作。后续输入");
    await expect.poll(() => quickFormat.isVisible()).toBe(false);
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => readFile(join(vault, "笔记.md"), "utf8")).toContain("$x+y+z$继续");

    await wiki.click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("heading", { name: "参考资料" }).waitFor();
    await page
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("treeitem", { name: "笔记.md", exact: true })
      .click();
    await link.click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("heading", { name: "参考资料" }).waitFor();

    await page
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("treeitem", { name: "长文.md", exact: true })
      .click();
    const firstParagraph = editor.locator(":scope > p").first();
    await firstParagraph.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    for (let index = 0; index < 8; index++) await page.keyboard.press("Shift+ArrowLeft");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("第一行目标内容。");
    await quickFormat.waitFor({ timeout: 3000 });
    const paragraphBounds = await firstParagraph.boundingBox();
    const mainBounds = await page.locator(".main").boundingBox();
    if (paragraphBounds === null || mainBounds === null) throw new Error("长文不可见");
    await page.mouse.move(mainBounds.x + mainBounds.width - 20, mainBounds.y + 100);
    await page.mouse.wheel(0, paragraphBounds.y - mainBounds.y - 4);
    await expect
      .poll(async () => {
        const bar = await quickFormat.boundingBox();
        const text = await firstParagraph.boundingBox();
        return bar !== null && text !== null && bar.y >= text.y + text.height;
      })
      .toBe(true);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => quickFormat.isVisible()).toBe(false);
    await page.mouse.wheel(0, -500);
    await quickFormat.waitFor();
    await page.setViewportSize({ width: 480, height: 800 });
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    await editor.focus();
    await quickFormat.waitFor();
    await page.emulateMedia({ colorScheme: "dark" });
    const narrowBar = await quickFormat.boundingBox();
    expect(narrowBar).not.toBeNull();
    expect(narrowBar!.x).toBeGreaterThanOrEqual(0);
    expect(narrowBar!.x + narrowBar!.width).toBeLessThanOrEqual(480);
    if (screenshots)
      await page.screenshot({
        path: join(screenshots, "selection-formatting-narrow-dark.png"),
        scale: "css",
      });
    await page.keyboard.press("Escape");
    expect(await quickFormat.isVisible()).toBe(false);
    expect(errors).toEqual([]);
  } catch (error) {
    // 失败可能正处于保存门禁；只终止本用例拥有的临时实例，避免关闭等待掩盖原始断言。
    app.process().kill("SIGKILL");
    throw error;
  } finally {
    if (!app.process().killed) await app.close();
  }
});
