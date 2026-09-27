import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("嵌入：列表内展开、循环检测与深度上限", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-embeds-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([
    mkdir(join(vault, "notes"), { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  const files: Record<string, string> = {
    // 甲 → 乙 → 丙 → 甲：三层内出现环。
    "甲.md": "# 甲\n\n![[乙]]\n",
    "乙.md": "# 乙\n\n乙正文标记\n\n![[丙]]\n",
    "丙.md": "# 丙\n\n丙正文标记\n\n![[甲]]\n",
    // 列表项整体是嵌入。
    "戊.md": "# 戊\n\n- ![[己]]\n",
    "notes/己.md":
      "己列表内容标记 $E=mc^2$ %%隐藏注释%%\n\n[下一篇](./下篇.md)\n\n> [!note]- 提示\n> 嵌入标注正文\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n<div><strong>HTML 渲染内容</strong></div>\n\n- [ ] 任务\n",
    "notes/下篇.md": "# 下一篇\n\n来自嵌入所在目录。\n",
  };
  // 丁1 → 丁2 → 丁3 → 丁4 → 丁5：深度上限（3 层）截断丁5。
  for (let index = 1; index <= 5; index += 1) {
    files[`丁${index}.md`] =
      index === 5
        ? "# 丁5\n\n丁5标记\n"
        : `# 丁${index}\n\n丁${index}标记\n\n![[丁${index + 1}]]\n`;
  }
  await Promise.all(
    Object.entries(files).map(([name, body]) => writeFile(join(vault, name), body)),
  );
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({
      reader: { vaultRoot: vault, currentPath: "甲.md", filesCollapsed: false, leftWidth: 260 },
      appearance: "light",
      window: null,
    }),
  );
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
    const editorText = () => page.locator(".ProseMirror").first().textContent();
    const documentReady = async (name: string) => {
      await page.waitForFunction(
        (expected) =>
          document.querySelector(".document-name")?.textContent === expected &&
          !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        name,
      );
    };
    const openViaTree = async (name: string) => {
      await page
        .getByRole("navigation", { name: "文件列表" })
        .locator(`[data-path="${name}"]`)
        .click();
      await documentReady(name);
    };

    // 环：乙、丙逐层展开，丙再嵌甲时停止并给出可见原因。
    await documentReady("甲.md");
    await expect.poll(editorText).toContain("乙正文标记");
    await expect.poll(editorText).toContain("丙正文标记");
    await expect.poll(editorText).toContain("循环嵌入");

    // 列表项内独立成段的嵌入同样展开。
    await openViaTree("戊.md");
    await expect.poll(editorText).toContain("己列表内容标记");
    const embedded = page.locator(".ProseMirror .ProseMirror");
    await embedded.locator("mjx-container").waitFor();
    await embedded.locator(".mermaid-preview svg").waitFor({ timeout: 15000 });
    expect(await embedded.locator(".mermaid-source").isVisible()).toBe(false);
    expect(await embedded.locator(".comment-inline").isVisible()).toBe(false);
    expect(await embedded.locator(".task-checkbox").isDisabled()).toBe(true);
    expect(await embedded.locator(".callout-title").getAttribute("readonly")).not.toBeNull();
    expect(await embedded.locator(".html-block strong").textContent()).toBe("HTML 渲染内容");
    await embedded.getByRole("button", { name: "展开标注" }).click();
    expect(await embedded.locator(".callout-content").isVisible()).toBe(true);
    await embedded.getByRole("link", { name: "下一篇" }).hover();
    const preview = page.locator(".hover-preview");
    await preview.waitFor();
    await expect.poll(() => preview.textContent()).toContain("来自嵌入所在目录");
    await preview.getByRole("button", { name: "./下篇.md" }).click();
    await documentReady("下篇.md");

    // 深度上限：第 3 层（丁4）仍展开，第 4 层（丁5）截断并说明。
    await openViaTree("丁1.md");
    await expect.poll(editorText).toContain("丁2标记");
    await expect.poll(editorText).toContain("丁4标记");
    await expect.poll(editorText).toContain("已达上限");
    expect(await editorText()).not.toContain("丁5标记");

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
