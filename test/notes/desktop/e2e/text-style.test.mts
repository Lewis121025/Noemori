import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("文字样式、剪贴板和已有提示块在真实编辑中保留选区，保存重开保持一致", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-text-style-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault"),
    state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const file = join(vault, "笔记.md");
  await writeFile(
    file,
    "# 文字与标注\n\n前文 重点内容 后文。\n\n粘贴位置\n\n> [!warning] 原有提示\n> 标注正文\n",
  );
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      appearance: "light",
      reader: { vaultRoot: vault, currentPath: "笔记.md", filesCollapsed: true },
    }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const app = await electron.launch({
    executablePath,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  const clipboard = await app.evaluateHandle(async ({ clipboard, ClipboardItem }) =>
    Promise.all(
      // 平台可能返回没有格式的空条目；空剪贴板快照不能构造 ClipboardItem。
      (await clipboard.read())
        .filter((item) => item.types.length > 0)
        .map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
              ),
            ),
        ),
    ),
  );
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    const toolbar = page.getByRole("toolbar", { name: "编辑工具栏", exact: true });
    await editor.locator("p", { hasText: "重点内容" }).evaluate((element) => {
      const node = element.firstChild;
      if (!node) throw new Error("正文未加载");
      element.closest<HTMLElement>(".ProseMirror")?.focus();
      window.getSelection()?.setBaseAndExtent(node, 3, node, 7);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await toolbar.getByRole("button", { name: "下划线", exact: true }).click();
    expect(await editor.locator("u").textContent()).toBe("重点内容");
    const color = async (menu: "文字颜色" | "高亮", value: string) => {
      await toolbar.getByRole("button", { name: menu, exact: true }).click();
      await toolbar
        .getByRole("menu", { name: menu, exact: true })
        .getByRole("menuitemradio", { name: value, exact: true })
        .click();
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("重点内容");
    };
    await color("文字颜色", "红色");
    await color("高亮", "蓝色");
    const foreground = editor.locator('[data-text-color="red"]').first();
    const background = editor.locator('[data-highlight-color="blue"]').first();
    expect(await foreground.evaluate((element) => getComputedStyle(element).color)).toBe(
      "rgb(180, 67, 67)",
    );
    expect(await background.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      "rgb(205, 225, 245)",
    );
    await page.evaluate(() => {
      document.documentElement.style.colorScheme = "dark";
    });
    expect(await foreground.evaluate((element) => getComputedStyle(element).color)).toBe(
      "rgb(238, 155, 153)",
    );
    expect(await background.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      "rgb(48, 79, 105)",
    );
    const captures = process.env.NOEMORI_TEXT_STYLE_SCREENSHOTS;
    if (captures) {
      await mkdir(captures, { recursive: true });
      await page.screenshot({ path: join(captures, "dark.png") });
    }
    await page.evaluate(() => {
      document.documentElement.style.colorScheme = "light";
    });
    await page.keyboard.press("ControlOrMeta+c");
    const copied = await app.evaluate(async ({ clipboard }) => {
      for (const item of await clipboard.read())
        if (item.types.includes("text/html")) return (await item.getType("text/html")).text();
      return "";
    });
    expect(copied).toContain("<u>");
    expect(copied).toContain('data-text-color="red"');
    await editor.locator("p", { hasText: /^粘贴位置$/ }).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.closest<HTMLElement>(".ProseMirror")?.focus();
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(() => editor.locator('[data-text-color="red"]').count()).toBe(2);
    expect(await editor.locator("u").allTextContents()).toEqual(["重点内容", "重点内容"]);
    await toolbar.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => editor.locator("p", { hasText: /^粘贴位置$/ }).count()).toBe(1);

    await toolbar.getByRole("button", { name: "插入", exact: true }).click();
    expect(await toolbar.getByRole("menuitem", { name: "标注", exact: true }).count()).toBe(0);
    await toolbar.getByRole("button", { name: "插入", exact: true }).click();
    const existing = editor.locator('.callout[data-callout="warning"]');
    const title = existing.locator(".callout-title");
    await title.fill("我的提示");
    await existing.locator(".callout-content p").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.closest<HTMLElement>(".ProseMirror")?.focus();
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.keyboard.insertText("（已改）");
    expect(await existing.locator(".callout-content").innerText()).toBe("标注正文（已改）");
    expect(await title.inputValue()).toBe("我的提示");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => readFile(file, "utf8")).toContain("[!warning] 我的提示");
    const saved = await readFile(file, "utf8");
    expect(saved).toContain("标注正文（已改）");
    expect(saved).toContain('<span style="color: #b44343">');
    expect(saved).toContain('<mark style="background-color: #cde1f5"><u>重点内容</u></mark>');
    expect(saved).toContain("前文");
    expect(saved).toContain("后文。");
    await page.reload();
    await editor.waitFor();
    await expect.poll(() => editor.locator('.callout[data-callout="warning"]').count()).toBe(1);
    expect(await title.inputValue()).toBe("我的提示");
    expect(await existing.locator(".callout-content").innerText()).toBe("标注正文（已改）");
    expect(await editor.locator("u").textContent()).toBe("重点内容");
    if (captures) await page.screenshot({ path: join(captures, "light.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.evaluate(
      ({ clipboard: systemClipboard }, saved) => systemClipboard.write(saved),
      clipboard,
    );
    await clipboard.dispose();
    await app.close();
  }
});
