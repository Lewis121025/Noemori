import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("链接补全：别名插入带显示名的链接；块引用自动为其他笔记与本笔记写入 ID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-completion-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "写作.md"), "# 写作\n\n本笔记的段落。\n\n"),
    writeFile(
      join(vault, "目标.md"),
      "---\naliases: [路线图]\n---\n\n# 目标\n\n需要被引用的段落。\n",
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "写作.md", filesCollapsed: false, leftWidth: 260 },
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
        document.querySelector(".document-name")?.textContent === "写作.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    const popup = page.getByRole("listbox", { name: "链接补全候选" });
    const saved = () => readFile(join(vault, "写作.md"), "utf8");

    // 别名补全。
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[路线");
    await expect.poll(() => popup.textContent()).toContain("别名 · 目标.md");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(saved).toContain("本笔记的段落。 [[目标|路线图]]");

    // 引用其他笔记的块：目标文件写入新 ID，本文插入 #^ID 链接。
    await page.keyboard.type(" [[目标#^需要");
    await expect.poll(() => popup.textContent()).toContain("需要被引用的段落。");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => readFile(join(vault, "目标.md"), "utf8"))
      .toMatch(/^---\naliases: \[路线图\]\n---\n\n# 目标\n\n需要被引用的段落。 \^[0-9a-z]{6}\n$/);
    const targetId = /\^([0-9a-z]{6})/.exec(await readFile(join(vault, "目标.md"), "utf8"))![1];
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(saved).toContain(`[[目标#^${targetId}]]`);

    // 引用本笔记的块：在编辑器里追加 ID，随保存落盘。
    await page.keyboard.press("Enter");
    await page.keyboard.type("见 [[#^本笔记");
    await expect.poll(() => popup.textContent()).toContain("本笔记的段落");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(saved)
      .toMatch(
        /本笔记的段落。 \[\[目标\|路线图\]\] \[\[目标#\^[0-9a-z]{6}\]\] \^([0-9a-z]{6})\n\n见 \[\[#\^\1\]\]/,
      );

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
