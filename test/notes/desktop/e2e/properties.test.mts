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

test("属性与正文分离：隐藏配置，编辑与源码往返保持属性字节", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-properties-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(userData, { recursive: true })]);
  const original = [
    "---",
    "cssclasses:",
    "  - nndl-bilingual",
    "status: draft # 进行中",
    "tags: [project]",
    "author:",
    "  name: 张三",
    "---",
    "",
    "# 标题",
    "",
    "正文。",
    "",
  ].join("\r\n");
  await Promise.all([
    writeFile(join(vault, "笔记.md"), original),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "笔记.md", filesCollapsed: false, leftWidth: 260 },
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
  const app = await electron.launch({
    executablePath: executable,
    colorScheme: null,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
      "--no-sandbox",
    ],
    env: environment,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "笔记.md" &&
        document.querySelector(".ProseMirror") !== null &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    const editor = page.locator(".ProseMirror");
    expect(await editor.locator('pre[data-markdown-source="block"]').isVisible()).toBe(false);
    expect(await editor.innerText()).not.toContain("cssclasses");
    expect(
      await editor.evaluate((node) => {
        const title = node.querySelector("h1")!;
        return title.getBoundingClientRect().top - node.getBoundingClientRect().top;
      }),
    ).toBeLessThanOrEqual(24);
    await editor.locator("h1").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ControlOrMeta+s");
    expect(await readFile(join(vault, "笔记.md"), "utf8")).toBe(original);
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    expect(await page.getByRole("button", { name: "笔记属性…", exact: true }).count()).toBe(0);
    expect(await page.locator('[aria-label="笔记属性"]').count()).toBe(0);
    const beforeBodyEdit = await readFile(join(vault, "笔记.md"), "utf8");
    const prefix = beforeBodyEdit.slice(0, beforeBodyEdit.indexOf("# 标题"));

    await page.keyboard.press("Escape");
    expect(await editor.innerText()).not.toContain("cssclasses");
    await editor.locator("p").last().click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("替换正文。");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => readFile(join(vault, "笔记.md"), "utf8")).toContain("替换正文。");
    expect((await readFile(join(vault, "笔记.md"), "utf8")).startsWith(prefix)).toBe(true);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => editor.innerText()).toContain("正文。");
    await noteAction(page, "切换源码视图");
    await expect.poll(() => page.locator(".cm-content").innerText()).toContain("cssclasses:");
    await noteAction(page, "切换排版视图");
    expect(await editor.innerText()).not.toContain("cssclasses");

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
