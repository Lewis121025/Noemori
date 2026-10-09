import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("章节折叠保留全文，跳转自动展开，表格移动保留内容、选区与撤销", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-editing-details-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault"),
    state = join(root, "state");
  await mkdir(vault);
  await mkdir(state);
  const file = join(vault, "笔记.md");
  const source =
    "\uFEFF# 研究笔记\r\n\r\n章节开篇。\r\n\r\n## 细节\r\n\r\n目标词与不能丢失的正文。\r\n\r\n# 对照\r\n\r\n| 名称 | 备注 |\r\n| :--- | ---: |\r\n| 第一 | **保留** |\r\n| 第二 | 资料 |\r\n";
  await writeFile(file, source);
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      appearance: "light",
      readingPalette: "green",
      reader: { vaultRoot: vault, currentPath: "笔记.md", filesCollapsed: false },
    }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const app = await electron.launch({
    executablePath,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    const toolbar = page.getByRole("toolbar", { name: "编辑工具栏", exact: true });
    const title = editor.getByRole("heading", { name: "研究笔记", exact: true });
    await editor.getByRole("heading", { name: "细节", exact: true }).hover();
    await editor.getByRole("button", { name: "折叠章节：细节", exact: true }).click();
    await title.hover();
    await editor.getByRole("button", { name: "折叠章节：研究笔记", exact: true }).click();
    expect(await editor.locator("h2").isVisible()).toBe(false);
    expect(await editor.locator("p", { hasText: "不能丢失" }).isVisible()).toBe(false);
    expect(await toolbar.getByRole("button", { name: "撤销", exact: true }).isDisabled()).toBe(
      true,
    );
    await page.keyboard.press("ControlOrMeta+s");
    expect(await readFile(file, "utf8")).toBe(source);
    await editor.getByRole("button", { name: "展开章节：研究笔记", exact: true }).click();
    expect(await editor.locator("h2").isVisible()).toBe(true);
    expect(await editor.locator("p", { hasText: "不能丢失" }).isVisible()).toBe(false);
    await title.hover();
    await editor.getByRole("button", { name: "折叠章节：研究笔记", exact: true }).click();
    await page.getByRole("button", { name: "文内查找", exact: true }).click();
    const query = page.getByRole("searchbox", { name: "查找", exact: true });
    await query.fill("目标词");
    await query.press("Enter");
    await expect.poll(() => editor.locator("p", { hasText: "不能丢失" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "关闭查找", exact: true }).click();
    await title.hover();
    await editor.getByRole("button", { name: "折叠章节：研究笔记", exact: true }).click();
    await page.getByRole("button", { name: "文章大纲", exact: true }).click();
    await page
      .locator(".outline-sidebar")
      .getByRole("button", { name: "细节", exact: true })
      .click();
    expect(await editor.locator("h2").isVisible()).toBe(true);
    await title.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await editor.getByRole("button", { name: "折叠章节：研究笔记", exact: true }).click();
    await page.keyboard.press("ArrowDown");
    expect(
      await page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest("h1")?.textContent,
      ),
    ).toBe("对照");
    expect(await editor.locator("h2").isVisible()).toBe(false);

    const move = async (group: "行" | "列", action: string) => {
      await toolbar.getByRole("button", { name: "表格操作", exact: true }).click();
      await toolbar.getByRole("menuitem", { name: group, exact: true }).click();
      await toolbar.getByRole("menuitem", { name: action, exact: true }).click();
    };
    await editor.locator("td strong").dblclick();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("保留");
    await move("行", "下移当前行");
    expect(await editor.locator("tr").nth(1).innerText()).toContain("第二");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("保留");
    await move("列", "左移当前列");
    expect(await editor.locator("th").allTextContents()).toEqual(["备注", "名称"]);
    expect(await editor.locator("th").first().getAttribute("data-align")).toBe("right");
    expect(await editor.locator("td strong").textContent()).toBe("保留");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("保留");
    await toolbar.getByRole("button", { name: "撤销", exact: true }).click();
    await toolbar.getByRole("button", { name: "撤销", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => readFile(file, "utf8")).toBe(source);

    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(640, 640),
    );
    await title.hover();
    const fold = editor.getByRole("button", { name: "展开章节：研究笔记", exact: true });
    const bounds = (await fold.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.width).toBeGreaterThanOrEqual(20);
    const captures = process.env.NOEMORI_EDITING_SCREENSHOTS;
    if (captures) {
      await mkdir(captures, { recursive: true });
      await page.screenshot({ path: join(captures, "folded.png") });
      await fold.click();
      await page.screenshot({ path: join(captures, "expanded.png") });
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
