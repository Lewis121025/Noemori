import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("原生菜单切换列表与引用，保留选区、任务状态和保存结果", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-block-formatting-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const file = join(vault, "结构.md");
  await writeFile(file, "- 普通项\n- [ ] 待办项\n- [x] 已完成\n\n> 已引用\n\n待引用\n\n后文\n");
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({
      reader: { vaultRoot: vault, currentPath: "结构.md", filesCollapsed: false },
    }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron 可执行文件");
  const app = await electron.launch({
    executablePath,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    const toolbar = page.getByRole("toolbar", { name: "编辑工具栏", exact: true });
    const list = toolbar.getByRole("button", { name: "列表", exact: true });
    const quote = toolbar.getByRole("button", { name: "引用", exact: true });
    const select = async (first: string, last = first): Promise<void> => {
      await editor.evaluate(
        (element, names) => {
          const paragraphs = Array.from(element.querySelectorAll("p"));
          const from = paragraphs.find((node) => node.textContent === names.first)?.firstChild;
          const to = paragraphs.find((node) => node.textContent === names.last)?.firstChild;
          if (!(from instanceof Text) || !(to instanceof Text)) throw new Error("测试选区不存在");
          if (!(element instanceof HTMLElement)) throw new Error("正文不是可聚焦元素");
          element.focus();
          element.ownerDocument.getSelection()?.setBaseAndExtent(from, 0, to, to.length);
        },
        { first, last },
      );
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString()))
        .toContain(first);
    };
    const choose = async (name: string): Promise<void> => {
      await list.click();
      await toolbar
        .getByRole("menu", { name: "列表", exact: true })
        .getByRole("menuitemradio", { name, exact: true })
        .click();
      expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("普通项");
    };

    await select("普通项", "已完成");
    await expect.poll(() => list.getAttribute("aria-pressed")).toBe("mixed");
    await choose("任务列表");
    expect(await editor.locator('li[data-checked="false"]').count()).toBe(2);
    expect(await editor.locator('li[data-checked="true"]').textContent()).toContain("已完成");
    await choose("编号列表");
    expect(await editor.locator("ol > li").count()).toBe(3);
    expect(await editor.locator("li[data-checked]").count()).toBe(0);
    await choose("编号列表");
    expect(await editor.locator("ol, ul").count()).toBe(0);

    await select("已引用", "待引用");
    await expect.poll(() => quote.getAttribute("aria-pressed")).toBe("mixed");
    await quote.click();
    expect(await editor.locator("blockquote blockquote").count()).toBe(0);
    await expect.poll(() => quote.getAttribute("aria-pressed")).toBe("true");
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);
    await quote.click();
    expect(await editor.locator("blockquote").count()).toBe(0);
    await expect.poll(() => quote.getAttribute("aria-pressed")).toBe("false");

    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForFunction(
      () => document.querySelector(".save-status")?.textContent === "已保存",
    );
    const saved = await readFile(file, "utf8");
    expect(saved).toBe("普通项\n\n待办项\n\n已完成\n\n已引用\n\n待引用\n\n后文\n");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
