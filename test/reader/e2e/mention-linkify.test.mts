import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("未链接提及就地转为链接：来源文件按字节改写，引用面板即时归组", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-linkify-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(userData, { recursive: true })]);
  await Promise.all([
    writeFile(join(vault, "目标笔记.md"), "# 目标笔记\n"),
    writeFile(join(vault, "ref.md"), "# Ref\n\n提到 目标笔记 的正文。\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          currentPath: "目标笔记.md",
          filesCollapsed: false,
          leftWidth: 260,
        },
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
        document.querySelector(".document-name")?.textContent === "目标笔记.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );

    // 引用面板的「可能相关的提及」里出现 ref.md 的未链接出现。
    const references = page.locator(".references");
    const suggestions = references.locator("details.suggestions");
    await suggestions.locator("summary").click();
    await expect.poll(() => suggestions.locator(".hit").count()).toBe(1);
    expect(await suggestions.locator(".hit").textContent()).toContain("目标笔记");

    // 就地转链接：来源文件按字节改写，其余正文不动。
    await suggestions.locator(".linkify").click();
    await expect
      .poll(() => readFile(join(vault, "ref.md"), "utf8"))
      .toBe("# Ref\n\n提到 [[目标笔记]] 的正文。\n");

    // 面板即时归组：候选提及消失，入链出现。
    await expect.poll(() => references.locator("details.suggestions").count()).toBe(0);
    await expect
      .poll(() => references.locator("details").first().locator("summary").textContent())
      .toContain("被 1 篇笔记引用");

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
