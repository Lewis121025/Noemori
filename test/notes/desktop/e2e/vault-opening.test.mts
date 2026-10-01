import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("真实窗口开库进度、取消、文件错误和修正重试", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-open-e2e-"));
  const first = join(root, "原资料");
  const large = join(root, "大资料");
  const broken = join(root, "待修正");
  const state = join(root, "state");
  const unreadable = join(broken, "不可读.md");
  t.onTestFinished(async () => {
    await chmod(unreadable, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([first, large, broken, state].map((path) => mkdir(path)));
  await Promise.all([
    writeFile(join(first, "原笔记.md"), "# 原笔记\n\n原工作区继续使用。\n"),
    writeFile(unreadable, "# 已修正\n\n原文件不应丢失。\n"),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ vaultRoot: first, currentPath: "原笔记.md", filesCollapsed: true }),
    ),
    ...Array.from({ length: 5000 }, (_, i) =>
      writeFile(
        join(large, `${i}.md`),
        `# 笔记 ${i}\n\n${"中文检索内容与链接 [[0]]。\n".repeat(80)}`,
      ),
    ),
  ]);
  await chmod(unreadable, 0);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
    ),
  );
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${state}`,
      "--no-sandbox",
    ],
    env,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByRole("heading", { name: "原笔记", exact: true }).waitFor();
    const open = async (path: string) => {
      await app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      }, path);
      const action = page.getByRole("button", { name: "打开笔记库…", exact: true });
      if (!(await action.isVisible()))
        await page.getByRole("button", { name: "切换笔记库", exact: true }).click();
      await action.click();
    };
    await open(large);
    const opening = page.getByRole("region", { name: "打开资料库", exact: true });
    await opening.waitFor();
    await opening.getByRole("button", { name: "取消打开", exact: true }).click();
    await opening.waitFor({ state: "hidden" });
    expect(await page.locator(".ProseMirror").textContent()).toContain("原工作区继续使用");
    expect(JSON.parse(await readFile(join(state, "session.json"), "utf8")).reader.vaultRoot).toBe(
      first,
    );
    await open(broken);
    await expect.poll(() => page.locator(".message").textContent()).toContain("不可读.md");
    expect(await page.locator(".document-name").textContent()).toBe("原笔记.md");
    await chmod(unreadable, 0o600);
    await open(broken);
    await expect
      .poll(() => page.getByRole("button", { name: "切换笔记库", exact: true }).textContent())
      .toContain("待修正");
    await page.getByRole("treeitem", { name: "不可读.md", exact: true }).dblclick();
    await page.getByRole("heading", { name: "已修正", exact: true }).waitFor();
  } finally {
    await app.close();
  }
});
