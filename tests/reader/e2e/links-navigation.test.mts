import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("链接跳转：路径锚点定位、同名歧义选择、文内锚点与失效锚点提示", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-links-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(userData, { recursive: true })]);
  await Promise.all([mkdir(join(vault, "a")), mkdir(join(vault, "b"))]);
  await Promise.all([
    writeFile(
      join(vault, "a/foo.md"),
      "# A Foo\n\n> [!note]- 外层\n>\n> > [!tip]- 内层\n> > ## 深入小节\n> >\n> > 深入小节的内容。\n",
    ),
    writeFile(join(vault, "b/foo.md"), "# B Foo\n\n乙的内容。\n"),
    writeFile(
      join(vault, "ref.md"),
      "# Ref\n\n## 本地小节\n\n本地内容。\n\n锚点 [[a/foo#深入小节]]\n\n歧义 [[foo]]\n\n文内 [[#本地小节]]\n\n失效 [[a/foo#不存在标题]]\n",
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          currentPath: "ref.md",
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
    const editor = page.locator(".document-body");
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    // 按链接目标属性精确选择，避免「foo」误中「a/foo#…」这类包含关系。
    const clickWiki = (target: string) =>
      editor.locator(`.wiki-link[data-wiki-target="${target}"]`).click({ modifiers: [modifier] });
    // 文档名更新早于切换门禁释放；必须等 inert 解除，否则紧随的合成按键
    // 会被 executeCommand 的 switching 门禁吞掉（与 files.test 的 active 同一约定）。
    const documentReady = (name: string) =>
      page.waitForFunction(
        (expected) =>
          document.querySelector(".document-name")?.textContent === expected &&
          !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        name,
      );

    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "ref.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );

    // 跨文件锚点：打开目标并把光标定位到标题。
    // 两级等待分开：先确认导航完成，再确认标题定位，失败时能区分环节。
    await clickWiki("a/foo#深入小节");
    await documentReady("foo.md");
    await page.waitForFunction(() =>
      (document.getSelection()?.anchorNode?.parentElement?.textContent ?? "").includes("深入小节"),
    );
    expect(await editor.locator(".callout").count()).toBe(2);
    expect(await editor.locator(".callout.collapsed").count()).toBe(0);
    expect(await editor.getByRole("heading", { name: "深入小节" }).isVisible()).toBe(true);

    // 阅读栈：菜单快捷键后退回到引用页，前进再次回到锚点目标。
    await page.keyboard.press("ControlOrMeta+[");
    await documentReady("ref.md");
    await page.keyboard.press("ControlOrMeta+]");
    await documentReady("foo.md");

    // 回到引用页，走文件树。
    await page
      .getByRole("navigation", { name: "文件列表" })
      .locator('[data-path="ref.md"]')
      .click();
    await documentReady("ref.md");

    // 出链面板：按索引解析状态分组，点击已解析出链走同一跳转链路。
    const outlinks = page.locator(".outlinks");
    await outlinks.locator("summary").click();
    const summary = await outlinks.locator("summary").textContent();
    expect(summary).toContain("本文引用 4 处");
    // 四条出链：两条唯一解析、一条同名歧义、一条纯锚点（self，不算未解析）。
    expect(summary).toContain("1 处需要查看");
    await outlinks.locator(".hit", { hasText: "a/foo#深入小节" }).first().click();
    await documentReady("foo.md");
    await page
      .getByRole("navigation", { name: "文件列表" })
      .locator('[data-path="ref.md"]')
      .click();
    await documentReady("ref.md");

    // 同名歧义：弹出候选，选择后打开对应文件。
    await clickWiki("foo");
    const dialog = page.getByRole("dialog", { name: "找到多篇同名笔记" });
    await dialog.waitFor();
    expect(await dialog.locator(".candidate").count()).toBe(2);
    await dialog.locator(".candidate", { hasText: "b/foo.md" }).click();
    await page.waitForFunction(
      () => document.querySelector(".file.active")?.getAttribute("data-path") === "b/foo.md",
    );
    expect(await dialog.count()).toBe(0);

    await page
      .getByRole("navigation", { name: "文件列表" })
      .locator('[data-path="ref.md"]')
      .click();
    await documentReady("ref.md");

    // 文内锚点：不切换文档，直接定位本地标题。
    await clickWiki("#本地小节");
    await page.waitForFunction(() =>
      (document.getSelection()?.anchorNode?.parentElement?.textContent ?? "").includes("本地小节"),
    );
    expect(await page.locator(".document-name").textContent()).toBe("ref.md");

    // 失效锚点：仍打开目标文件，但给出可见提示。
    await clickWiki("a/foo#不存在标题");
    await documentReady("foo.md");
    await expect.poll(async () => page.getByRole("alert").textContent()).toContain("未找到标题");

    // 内联补全：回到引用页，在文末输入触发候选并回车，插入真实链接结构。
    await page
      .getByRole("navigation", { name: "文件列表" })
      .locator('[data-path="ref.md"]')
      .click();
    await documentReady("ref.md");
    const surface = page.locator(".surface .ProseMirror");
    await surface.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.type(" [[b/");
    const popup = page.getByRole("listbox", { name: "链接补全候选" });
    await popup.waitFor();
    expect(await popup.locator("[role='option']").first().textContent()).toContain("b/foo.md");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector('.wiki-link[data-wiki-target="b/foo"]') !== null,
    );

    // 锚点补全：#[[a/foo#深 触发标题候选，插入完整锚点链接。
    await page.keyboard.type("[[a/foo#深");
    await popup.waitFor();
    expect(await popup.locator("[role='option']").first().textContent()).toContain("深入小节");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector('.wiki-link[data-wiki-target="a/foo#深入小节"]') !== null,
    );

    // 保存后磁盘上是干净的链接语法，而不是被转义的字面括号。
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(async () => (await readFile(join(vault, "ref.md"), "utf8")).includes("[[b/foo]]"))
      .toBe(true);
    const saved = await readFile(join(vault, "ref.md"), "utf8");
    expect(saved).toContain("[[a/foo#深入小节]]");
    expect(saved).not.toContain("\\[\\[");

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
