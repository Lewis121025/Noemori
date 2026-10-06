import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { openLibrary } from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("死链创建：#标题锚点随创建写入新笔记并直接定位", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-dead-link-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(userData, { recursive: true })]);
  await Promise.all([
    writeFile(join(vault, "ref.md"), "# Ref\n\n去 [[新笔记#计划小节]] 看看。\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "ref.md", filesCollapsed: false, leftWidth: 260 },
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
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "ref.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );

    // 点击死链弹出创建确认，文案承诺种子标题。
    await page
      .locator('.wiki-link[data-wiki-target="新笔记#计划小节"]')
      .click({ modifiers: [modifier] });
    const dialog = page.getByRole("dialog", { name: "笔记不存在" });
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain("将写入标题「计划小节」");

    await dialog.getByRole("button", { name: "创建笔记", exact: true }).click();

    // 新笔记打开、光标落在种下的标题上，磁盘字节就是种子内容。
    await page.waitForFunction(
      () => document.querySelector(".document-name")?.textContent === "新笔记.md",
    );
    await page.waitForFunction(() =>
      (document.getSelection()?.anchorNode?.parentElement?.textContent ?? "").includes("计划小节"),
    );
    await expect.poll(() => readFile(join(vault, "新笔记.md"), "utf8")).toBe("# 计划小节\n\n");
    // 文件系统同步出现新条目，且没有误报锚点失效。
    await openLibrary(page);
    await expect
      .poll(() =>
        page
          .getByRole("grid")
          .getByRole("button", { name: "新笔记.md", exact: true })
          .count(),
      )
      .toBe(1);
    expect(await page.getByRole("alert").count()).toBe(0);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
