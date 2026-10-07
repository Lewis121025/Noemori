import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import { expect, test } from "vitest";
import { openLibrary, newEntry, openSettings } from "../support/workspace-actions";
const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("层级工作台：真实全文、修改时间、文章对话、创建位置与窄屏焦点", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-hierarchy-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  let vault = join(root, "vault");
  const state = join(root, "state");
  await mkdir(join(vault, "研究/光学"), { recursive: true });
  await mkdir(join(vault, "归档"));
  await mkdir(state);
  vault = await realpath(vault);
  const path = "研究/光学/折射与斯涅尔定律.md";
  const source =
    "# 折射与斯涅尔定律\n\n## 角度的定义\n\n入射角与折射角都以界面法线为基准。光线与法线位于同一个平面内。\n\n$$n_1 \\sin \\theta_1 = n_2 \\sin \\theta_2$$\n\n## 从空气进入玻璃\n\n介质的折射率增大时，光线向法线偏折。\n";
  await writeFile(join(vault, path), source);
  await writeFile(join(vault, "研究/光学/波前.md"), "# 惠更斯原理\n\n次级波面描述波前的传播。\n");
  await writeFile(join(vault, "归档/折射摘录.md"), "# 折射摘录\n\n整理教材与实验出处。\n");
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      reader: { vaultRoot: vault, currentPath: path, filesCollapsed: false },
      appearance: "light",
    }),
  );
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron");
  const app = await electron.launch({
    executablePath: executable,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", NOEMORI_TEST_WINDOW: "hidden" },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1120, height: 800 });
    await openLibrary(page);
    const library = page.locator(".library"),
      preview = library.getByRole("region", { name: "资料预览" });
    const files = library.getByRole("navigation", { name: "文件列表" });
    const row = (path: string) => files.locator(`button[data-path="${path}"]`);
    const input = files.getByRole("searchbox");
    await row(path).click();
    await preview
      .locator(".library-document")
      .getByRole("heading", { name: "角度的定义" })
      .waitFor();
    expect(await page.locator(".file-sidebar").evaluate((el) => el.clientWidth)).toBeLessThan(70);
    expect(await page.locator(".folder-navigation").count()).toBe(0);
    await input.fill("法线");
    await files.locator(".excerpt").waitFor();
    expect(await row("研究").count()).toBe(1);
    expect(await row("研究/光学").count()).toBe(1);
    await input.press("ArrowDown");
    expect(await row(path).evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    expect(await files.locator('[aria-selected="true"]').count()).toBe(1);
    await preview.getByRole("button", { name: "下一处匹配", exact: true }).click();
    expect(await preview.locator(".ProseMirror-active-search-match").count()).toBe(1);
    await preview.getByRole("button", { name: "文件信息", exact: true }).click();
    await library.getByRole("dialog", { name: "文件信息" }).waitFor();
    expect(await library.getByRole("dialog", { name: "文件信息" }).innerText()).toContain("修改");
    await page.keyboard.press("Escape");
    await input.press("Escape");
    await row(path).click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名…", exact: true }).click();
    const rename = files.getByRole("textbox", { name: "重命名文件", exact: true });
    expect(
      await rename.evaluate((node) => {
        if (!(node instanceof HTMLInputElement)) throw new Error("重命名控件不是输入框");
        return node.value.slice(node.selectionStart ?? 0, node.selectionEnd ?? 0);
      }),
    ).toBe("折射与斯涅尔定律");
    await rename.press("Escape");
    await newEntry(page, "笔记");
    const creation = page.getByRole("dialog", { name: "新建笔记", exact: true });
    expect(
      await creation
        .getByRole("textbox", { name: "名称", exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
    expect(await creation.locator(".destination").innerText()).toContain("研究/光学/");
    await creation.getByRole("button", { name: "取消", exact: true }).click();
    await openSettings(page);
    await page
      .getByRole("dialog", { name: "设置", exact: true })
      .getByRole("button", { name: "关闭设置" })
      .click();
    const conversation = await page.evaluate(
      async ({ root, path }) => {
        await window.noemori.agent.providersSave({
          protocol: "openai-chat",
          id: null,
          name: "本地测试供应商",
          address: { type: "endpoint", url: "http://127.0.0.1:1/model" },
          authentication: { type: "none" },
          models: [
            {
              id: "local-fixture",
              tools: true,
              streaming: false,
              vision: false,
              audio: false,
              video: false,
            },
          ],
        });
        await window.noemori.agent.attachVault(root);
        return window.noemori.agent.createArticle({ root, path, title: "理解折射" });
      },
      { root: vault, path },
    );
    await writeFile(
      join(vault, path),
      `${source}\n[讨论：理解折射](noemori://conversation/${conversation.id})\n`,
    );
    await preview.locator(`a[href="noemori://conversation/${conversation.id}"]`).waitFor();
    await preview.locator(`a[href="noemori://conversation/${conversation.id}"]`).click();
    await preview.getByRole("button", { name: "继续对话", exact: true }).waitFor();
    expect(await preview.getByRole("button", { name: "理解折射", exact: true }).count()).toBe(1);
    await preview.getByRole("button", { name: "返回原文", exact: true }).click();
    await preview.locator(".library-document").waitFor();
    await input.fill("折射");
    await expect.poll(() => files.locator(".result-count").innerText()).toBe("2");
    const shots = process.env.NOEMORI_FILE_MANAGER_SCREENSHOTS;
    if (shots) await page.screenshot({ path: join(shots, "hierarchy-wide.png") });
    await page.setViewportSize({ width: 600, height: 700 });
    await library.getByRole("button", { name: "预览", exact: true }).click();
    await preview.getByRole("button", { name: "预览", exact: true }).press("Escape");
    await expect.poll(() => files.isVisible()).toBe(true);
    const rail = await page.locator(".file-sidebar").boundingBox();
    const libraryBounds = await library.boundingBox();
    expect(libraryBounds!.x).toBeGreaterThanOrEqual(rail!.x + rail!.width - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (shots) await page.screenshot({ path: join(shots, "hierarchy-narrow.png") });
    expect(errors).toEqual([]);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((win) => !win.isVisible() && !win.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
