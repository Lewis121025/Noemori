import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("双链显示：来源与目标去重、内部锚点分区、逐处跳转与高度调整", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-links-display-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(
      join(vault, "当前.md"),
      "# 当前\n\n## 本节\n\n[[目标#甲节]] [[目标#乙节]] [本节](#本节) [[当前#本节]]\n",
    ),
    writeFile(join(vault, "来源.md"), "# 来源\n\n开头 [[当前]] 中间 [[当前]] 结尾。\n"),
    writeFile(join(vault, "目标.md"), "# 目标\n\n## 甲节\n\n甲内容。\n\n## 乙节\n\n乙内容。\n"),
    writeFile(join(vault, "提及.md"), "# 提及\n\n提到 当前 的正文。\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          currentPath: "当前.md",
          filesCollapsed: false,
          leftWidth: 260,
          sidebarView: "outline",
        },
        appearance: "light",
        window: null,
      }),
    ),
  ]);
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron 可执行文件");
  const app = await electron.launch({
    executablePath,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
      "--no-sandbox",
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
      ),
    ),
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("缺少应用窗口");
      window.setContentSize(1100, 760);
    });
    const documentReady = (name: string) =>
      page.waitForFunction(
        (expected) =>
          document.querySelector(".document-name")?.textContent === expected &&
          !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        name,
      );
    await documentReady("当前.md");
    const toggle = page.getByRole("button", { name: "双链", exact: true });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await toggle.click();
    const incoming = page.getByRole("button", { name: "入链", exact: true });
    const outgoing = page.getByRole("button", { name: "出链", exact: true });
    const mentions = page.getByRole("button", { name: "提及", exact: true });
    await expect.poll(async () => (await incoming.textContent())?.trim()).toBe("1");
    await expect.poll(async () => (await outgoing.textContent())?.trim()).toBe("1");
    expect(await incoming.getAttribute("title")).toContain("其他笔记 → 当前笔记");
    expect(await outgoing.getAttribute("title")).toContain("当前笔记 → 其他目标");
    expect(await incoming.getAttribute("aria-pressed")).toBe("true");
    const references = page.locator(".references");
    expect(await references.locator(".group").count()).toBe(1);
    expect(await references.locator(".hit").count()).toBe(1);
    expect(await references.getByRole("button").count()).toBe(2);
    expect(await references.locator(".occurrence-count").textContent()).toBe("×2");
    if (process.env.NOEMORI_LINKS_DISPLAY_SCREENSHOT)
      await page.screenshot({ path: process.env.NOEMORI_LINKS_DISPLAY_SCREENSHOT });

    // 合并摘要后每个数字仍定位原文中的不同位置，不能都跳到第一处。
    await references.getByRole("button", { name: "第 2 处引用", exact: true }).click();
    await documentReady("来源.md");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = document.getSelection();
          const node = selection?.anchorNode;
          const paragraph = (node instanceof Element ? node : node?.parentElement)?.closest("p");
          if (!selection || !node || !paragraph) return "";
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          range.setEnd(node, selection.anchorOffset);
          return range.toString();
        }),
      )
      .toContain("中间");
    await page.keyboard.press("ControlOrMeta+[");
    await documentReady("当前.md");

    await outgoing.click();
    const targets = page.locator(".outlinks > ul > .outlink-group");
    await expect.poll(() => targets.locator(".raw").textContent()).toBe("目标.md");
    expect(await targets.count()).toBe(1);
    expect(await targets.getByRole("button").count()).toBe(2);
    expect(await targets.locator(".occurrence-count").textContent()).toBe("×2");
    await page.getByRole("region", { name: "本文内部跳转", exact: true }).waitFor();
    expect(
      await page
        .getByRole("region", { name: "本文内部跳转", exact: true })
        .getByRole("button")
        .count(),
    ).toBe(2);
    await targets.getByRole("button", { name: "第 2 处引用：目标#乙节", exact: true }).click();
    await documentReady("目标.md");
    await expect
      .poll(() =>
        page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.textContent),
      )
      .toContain("乙节");
    await page.keyboard.press("ControlOrMeta+[");
    await documentReady("当前.md");
    await page
      .getByRole("region", { name: "本文内部跳转", exact: true })
      .getByRole("button", { name: "#本节", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.textContent),
      )
      .toContain("本节");
    expect(await page.locator(".document-name").textContent()).toBe("当前.md");
    await mentions.click();
    expect(await references.locator(".suggestions .group").count()).toBe(1);
    expect(await references.getByRole("button", { name: "转为链接", exact: true }).count()).toBe(1);

    const panel = page.getByRole("region", { name: "双链面板", exact: true });
    const separator = page.getByRole("separator", { name: "调整双链高度", exact: true });
    const initialHeight = (await panel.boundingBox())!.height;
    const grip = (await separator.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 48, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(async () => (await panel.boundingBox())!.height)
      .toBeCloseTo(initialHeight + 48, 0);
    await toggle.click();
    await toggle.click();
    expect(await mentions.getAttribute("aria-pressed")).toBe("true");
    expect((await panel.boundingBox())!.height).toBeCloseTo(initialHeight + 48, 0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("链接跳转：路径锚点定位、同名歧义选择、文内锚点与失效锚点提示", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-links-test-"));
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
