import { openLibrary } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("书签：收藏文件夹、文件与标题，侧栏打开、键盘重排，失效目标置灰", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-bookmarks-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(join(vault, "项目"), { recursive: true }), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "首页.md"), "# 首页\n\n入口。\n\n## 第二节\n\n细节。\n"),
    writeFile(join(vault, "项目/计划.md"), "# 计划\n"),
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
    const palette = page.locator("dialog.picker[open]").getByRole("combobox");
    const documentName = () => page.locator(".document-name").first().textContent();
    const stored = async () =>
      JSON.parse(await readFile(join(vault, ".noemori/bookmarks.json"), "utf8").catch(() => "{}"));
    const runCommand = async (label: string) => {
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".pane-column")].every((pane) => !pane.hasAttribute("inert")),
      );
      await page.keyboard.press("ControlOrMeta+p");
      await palette.fill(label);
      await palette.press("Enter");
    };
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "首页.md" &&
        document.querySelector(".ProseMirror") !== null &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );

    await openLibrary(page);
    // 文件夹经右键菜单收藏。
    await page
      .getByRole("region", { name: "文件系统", exact: true })
      .getByRole("button", { name: "项目" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "加入书签" }).click();
    await page.getByRole("button", { name: "← 返回文档", exact: true }).click();
    // 当前文件与光标所在章节经命令面板收藏。
    await runCommand("收藏或取消收藏当前文件");
    // 经目录跳到章节：选区由编辑器事务同步落进标题。
    await page.getByRole("button", { name: "目录", exact: true }).click();
    await page.getByRole("navigation", { name: "文档目录" }).getByText("第二节").click();
    await runCommand("收藏或取消收藏当前标题");
    await expect
      .poll(async () => (await stored()).items)
      .toEqual([
        { kind: "folder", path: "项目" },
        { kind: "file", path: "首页.md" },
        { kind: "heading", path: "首页.md", heading: "第二节" },
      ]);

    // 书签是库内点目录里的用户数据，不进文件树。
    expect(
      await page
        .getByRole("region", { name: "文件系统", exact: true })
        .getByRole("button", { name: ".noemori" })
        .count(),
    ).toBe(0);

    await openLibrary(page);
    await page
      .getByRole("region", { name: "文件系统", exact: true })
      .getByRole("button", { name: "书签", exact: true })
      .click();
    const rows = page.getByRole("list", { name: "书签" }).locator("button.open .name");
    await expect.poll(() => rows.allTextContents()).toEqual(["项目", "首页", "首页 › 第二节"]);

    // 从另一篇笔记经标题书签回来。
    await openLibrary(page);
    await page
      .getByRole("region", { name: "文件系统", exact: true })
      .getByRole("button", { name: "书签", exact: true })
      .click();
    await page
      .getByRole("region", { name: "文件系统", exact: true })
      .getByRole("button", { name: "项目", exact:true })
      .dblclick();
    await page
      .getByRole("region", { name: "文件系统", exact: true })
      .getByRole("button", { name: "计划.md" })
      .dblclick();
    await expect.poll(documentName).toBe("计划.md");
    await runCommand("显示书签");
    await rows.nth(2).click();
    await expect.poll(documentName).toBe("首页.md");

    await runCommand("显示书签");
    // Alt+↑ 把标题书签上移一位，顺序写回文件。
    await page.getByRole("list", { name: "书签" }).locator("button.open").nth(2).focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => rows.allTextContents()).toEqual(["项目", "首页 › 第二节", "首页"]);
    await expect
      .poll(async () => (await stored()).items.map((item: { kind: string }) => item.kind))
      .toEqual(["folder", "heading", "file"]);

    // 外部删除文件夹：书签保留但置灰，可以直接移除。
    await rm(join(vault, "项目"), { recursive: true, force: true });
    const folderRow = page.getByRole("list", { name: "书签" }).locator("li").first();
    await expect.poll(() => folderRow.getAttribute("class")).toContain("missing");
    await page.getByRole("button", { name: "移除书签「项目」" }).click();
    await expect.poll(() => rows.allTextContents()).toEqual(["首页 › 第二节", "首页"]);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
