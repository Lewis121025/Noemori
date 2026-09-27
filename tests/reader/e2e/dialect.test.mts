import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

const source = [
  "# 方言",
  "",
  "普通 ==高亮== 与 %%行内注释%% 以及脚注[^1]。",
  "",
  "> [!warning]- 小心",
  "> 标注正文",
  "",
  "```mermaid",
  "graph TD",
  "  A-->B",
  "```",
  "",
  "[^1]: 脚注定义",
  "",
].join("\n");

test("Obsidian 方言：高亮、注释、标注、脚注与 Mermaid 渲染，编辑后未改片段逐字节保留", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-dialect-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "方言.md"), source),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "方言.md", filesCollapsed: false, leftWidth: 260 },
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
        document.querySelector(".document-name")?.textContent === "方言.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    const editor = page.locator(".ProseMirror");

    expect(await editor.locator("mark").textContent()).toBe("高亮");
    expect(await editor.locator(".comment-inline").textContent()).toBe("%%行内注释%%");
    expect(await editor.locator(".footnote-ref").textContent()).toBe("1");
    const callout = editor.locator(".callout");
    expect(await callout.getAttribute("data-callout")).toBe("warning");
    expect(await callout.getAttribute("class")).toContain("collapsed");
    expect(await callout.locator(".callout-title").inputValue()).toBe("小心");
    // Mermaid 在生产 CSP 下按需加载并输出 SVG。
    await editor.locator(".mermaid-preview svg").waitFor({ timeout: 15000 });

    // 展开标注并改正文：只重写标注块，其余字节不变。
    await callout.locator(".callout-fold").click();
    await callout.locator(".callout-content p").click();
    await page.keyboard.press("End");
    await page.keyboard.type("（已改）");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "方言.md"), "utf8"))
      .toBe(source.replace("> 标注正文", "> 标注正文（已改）"));

    // 点击脚注引用跳到定义。
    await editor.locator(".footnote-ref").click();
    await page.waitForFunction(
      () => document.getSelection()?.anchorNode?.parentElement?.textContent === "脚注定义",
    );

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
