import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("快速切换器与命令面板：模糊打开、别名命中、另一栏打开、新建与执行命令", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-switcher-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(join(vault, "项目"), { recursive: true }), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "首页.md"), "# 首页\n\n入口。\n"),
    writeFile(
      join(vault, "项目/路线图.md"),
      ["---", "aliases: [Roadmap]", "---", "", "# 路线图", "", "季度计划。", ""].join("\n"),
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "首页.md", filesCollapsed: false, leftWidth: 260 },
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
    const picker = page.locator("dialog.picker[open]");
    const input = picker.getByRole("combobox");
    const options = picker.getByRole("option");
    const documentName = () => page.locator(".document-name").first().textContent();

    // 分栏切换门禁期间快捷键按设计被忽略；门禁落在分栏自身的 inert 上。
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "首页.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );

    // 别名命中：输入英文别名找到中文笔记，Enter 在当前栏打开。
    await page.keyboard.press("ControlOrMeta+o");
    await input.waitFor();
    await input.fill("roadmap");
    await expect.poll(async () => options.first().textContent()).toContain("别名：Roadmap");
    await input.press("Enter");
    await expect.poll(documentName).toBe("路线图.md");
    expect(await picker.count()).toBe(0);

    // 空查询列出最近打开，Esc 关闭且不改变当前文档。
    await page.keyboard.press("ControlOrMeta+o");
    await input.waitFor();
    await expect
      .poll(async () => (await options.allTextContents()).map((text) => text.trim().split(/\s/)[0]))
      .toEqual(["路线图", "首页"]);
    await input.press("Escape");
    await expect.poll(async () => picker.count()).toBe(0);
    expect(await documentName()).toBe("路线图.md");

    // Cmd/Ctrl+Enter：拆出第二栏并在其中打开。
    await page.keyboard.press("ControlOrMeta+o");
    await input.fill("首页");
    await input.press("ControlOrMeta+Enter");
    await expect.poll(async () => page.locator("section[data-pane]").count()).toBe(2);
    // 原栏保留原文档，新栏成为活动栏。
    await expect
      .poll(async () => page.locator("section[data-pane] .ProseMirror h1").allTextContents())
      .toEqual(["路线图", "首页"]);
    await expect.poll(documentName).toBe("首页.md");

    // 无命中时 Enter 按输入新建笔记。
    await page.keyboard.press("ControlOrMeta+o");
    await input.fill("会议记录");
    await expect.poll(async () => options.count()).toBe(0);
    await input.press("Enter");
    await expect.poll(async () => page.getByRole("treeitem", { name: /会议记录/ }).count()).toBe(1);

    // 命令面板：执行「切换分栏」合回单栏。
    await page.keyboard.press("ControlOrMeta+p");
    await input.fill("切换分栏");
    await input.press("Enter");
    await expect.poll(async () => page.locator("section[data-pane]").count()).toBe(1);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
