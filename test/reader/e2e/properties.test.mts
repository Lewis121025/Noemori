import { noteAction } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("属性面板：行级外科编辑，注释、顺序与嵌套结构逐字节保留", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-properties-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(userData, { recursive: true })]);
  const original = [
    "---",
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
    await noteAction(page, "笔记属性…");
    const properties = page.locator(".properties");
    await expect
      .poll(() => properties.locator(".row .key").allTextContents())
      .toEqual(["status", "tags", "author"]);
    // 块级结构只读，引导走源码模式。
    expect(await properties.locator(".nested").textContent()).toBe("嵌套结构");

    // 改值：尾注释保留，其余行不动。
    const statusInput = properties.getByLabel("属性 status 的值");
    await statusInput.fill("done");
    await statusInput.press("Enter");
    // 增键：插在闭合围栏前。
    await properties.getByLabel("新属性键").fill("due");
    const valueInput = properties.getByLabel("新属性值");
    await valueInput.fill("明天");
    await valueInput.press("Enter");
    // 删键：整行移除。
    await properties.getByLabel("删除属性 tags").click();

    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "笔记.md"), "utf8"))
      .toBe(
        [
          "---",
          "status: done # 进行中",
          "author:",
          "  name: 张三",
          "due: 明天",
          "---",
          "",
          "# 标题",
          "",
          "正文。",
          "",
        ].join("\r\n"),
      );

    // 面板与文档同步：删除的键消失，新键出现。
    await expect
      .poll(() => properties.locator(".row .key").allTextContents())
      .toEqual(["status", "author", "due"]);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
