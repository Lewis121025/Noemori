import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { openSettings } from "../support/workspace-actions";
import { visualViewports } from "../fixtures/quality-scenes";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("表格插入、连续写作、结构编辑、撤销和重启保留内容与焦点", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-table-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  const file = join(vault, "表格.md");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(file, "\uFEFF前文 _原样_\r\n\r\n后文"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "表格.md", filesCollapsed: true }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  const launch = () =>
    electron.launch({
      executablePath: executable,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${userData}`,
        "--no-sandbox",
      ],
      colorScheme: null,
      env: environment,
    });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");

    const panel = page
      .locator(".topbar-document:not([hidden])")
      .getByRole("toolbar", { name: "编辑工具栏", exact: true });
    const run = async (name: string) => {
      await page
        .locator(".topbar-document:not([hidden])")
        .getByRole("toolbar", { name: "编辑工具栏", exact: true })
        .waitFor();
      if (name === "撤销" || name === "重做") {
        await panel.getByRole("button", { name, exact: true }).click();
      } else if (name === "插入表格") {
        await panel.getByRole("button", { name: "插入", exact: true }).click();
        await panel.getByRole("menuitem", { name: "表格…", exact: true }).click();
        const picker = panel.getByRole("dialog", { name: "插入表格", exact: true });
        await picker.locator('[data-table-rows="2"][data-table-columns="2"]').click();
        await picker.getByRole("button", { name: "左对齐", exact: true }).click();
        await picker.getByRole("button", { name: "插入表格", exact: true }).click();
      } else {
        await panel.getByRole("button", { name: "表格操作", exact: true }).click();
        const category = name.includes("对齐") ? "列对齐" : name.includes("行") ? "行" : name.includes("列") ? "列" : null;
        if (category) await panel.getByRole("menuitem", { name: category, exact: true }).click();
        await panel.getByRole(name.includes("对齐") ? "menuitemradio" : "menuitem", { name, exact: true }).click();
      }
      expect(await panel.isVisible()).toBe(true);
      expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);
    };
    const save = async () => {
      await page.keyboard.press("ControlOrMeta+s");
      await expect.poll(() => page.locator(".save-status").textContent()).toBe("已保存");
      return readFile(file, "utf8");
    };
    await editor.locator("p").first().click();
    await panel.getByRole("button", { name: "插入", exact: true }).click();
    await panel.getByRole("menuitem", { name: "表格…", exact: true }).click();
    const picker = panel.getByRole("dialog", { name: "插入表格", exact: true });
    await picker.locator('[data-table-rows="4"][data-table-columns="5"]').hover();
    await expect.poll(() => picker.locator("output").textContent()).toBe("5 列 × 4 行");
    expect(await editor.locator("table").count()).toBe(0);
    await picker.locator('[data-table-rows="4"][data-table-columns="5"]').click();
    await picker.getByRole("button", { name: "居中", exact: true }).click();
    await expect.poll(() => picker.locator("output").textContent()).toBe("5 列 × 4 行");
    const pickerArtifacts = process.env.NOEMORI_TABLE_ARTIFACTS;
    if (pickerArtifacts) {
      await mkdir(pickerArtifacts, { recursive: true });
      await page.screenshot({ path: join(pickerArtifacts, "table-picker.png") });
    }
    await picker.getByRole("button", { name: "取消插入表格", exact: true }).click();
    expect(await editor.locator("table").count()).toBe(0);
    expect(await readFile(file, "utf8")).toBe("\uFEFF前文 _原样_\r\n\r\n后文");
    await run("插入表格");
    expect(await editor.locator("th").count()).toBe(2);
    await page.keyboard.insertText("项目");
    await page.keyboard.press("Tab");
    await page.keyboard.insertText("结论");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("待处理");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.insertText("记录");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("下一条");
    await page.keyboard.press("Tab");
    await page.keyboard.insertText("未完成");
    expect(await editor.locator("tr").count()).toBe(3);
    await run("右侧插入列");
    await page.keyboard.insertText("备注");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("备注");
    await run("列居中对齐");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("备注");
    expect(await editor.locator('th[data-align="center"],td[data-align="center"]').count()).toBe(3);
    const aligned = await save();
    expect(aligned.startsWith("\uFEFF前文 _原样_\r\n\r\n")).toBe(true);
    expect(aligned.endsWith("\r\n\r\n后文")).toBe(true);
    expect(aligned).toContain("备注");
    expect(aligned).toMatch(/\|[^\r\n]*:-+: \|/);
    await run("撤销");
    expect(await editor.locator('[data-align="center"]').count()).toBe(0);
    expect(await editor.innerText()).toContain("备注");
    await run("重做");
    expect(await save()).toBe(aligned);

    // 表格的工具同样遵守最小窗口和浅深色；截图留在显式指定的仓库外目录。
    const artifacts = process.env.NOEMORI_TABLE_ARTIFACTS;
    if (artifacts) await mkdir(artifacts, { recursive: true });
    for (const appearance of ["浅色", "深色"]) {
      await openSettings(page);
      await page.getByRole("button", { name: appearance, exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(appearance === "深色");
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "hidden" });
      const sidebarToggle = page.getByRole("button", { name: "显示或隐藏文件栏", exact: true });
      if (await sidebarToggle.getAttribute("aria-expanded") === "true") await sidebarToggle.click();
      for (const viewport of visualViewports) {
        await app.evaluate(({ BrowserWindow }, { width, height }) => {
          const window = BrowserWindow.getAllWindows()[0];
          if (window === undefined) throw new Error("应用窗口不存在");
          window.setContentSize(width, height);
        }, viewport);
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(viewport.width);
        await editor.locator("td").last().click();
        await page
          .locator(".topbar-document:not([hidden])")
          .getByRole("toolbar", { name: "编辑工具栏", exact: true })
          .waitFor();
        expect(
          await panel.getByRole("button", { name: "插入", exact: true }).isVisible(),
        ).toBe(true);
        const insertButton = panel.getByRole("button", { name: "插入", exact: true });
        await insertButton.focus();
        const bounds = await insertButton.boundingBox();
        if (bounds === null) throw new Error("表格面板不可见");
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        await panel.getByRole("button", { name: "表格操作", exact: true }).click();
        await panel.getByRole("menuitem", { name: "列对齐", exact: true }).hover();
        const alignmentMenu = panel.getByRole("menu", { name: "列对齐", exact: true });
        await alignmentMenu.waitFor();
        const alignmentBounds = (await alignmentMenu.boundingBox())!;
        expect(alignmentBounds.x).toBeGreaterThanOrEqual(0);
        expect(alignmentBounds.x + alignmentBounds.width).toBeLessThanOrEqual(viewport.width);
        await alignmentMenu.getByRole("menuitemradio", { name: "列左对齐", exact: true }).focus();
        await page.keyboard.press("Escape");
        await alignmentMenu.waitFor({ state: "hidden" });
        await page.keyboard.press("Escape");
        await panel.getByRole("menu", { name: "表格操作", exact: true }).waitFor({ state: "hidden" });
        await page.keyboard.press("Escape");
        await panel.getByRole("menu", { name: "插入", exact: true }).waitFor({ state: "hidden" });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (artifacts) {
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          const bytes = await app.evaluate(async ({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            if (window === undefined) throw new Error("应用窗口不存在");
            const [width, height] = window.getContentSize();
            if (width === undefined || height === undefined) throw new Error("窗口尺寸不可用");
            return (await window.capturePage()).resize({ width, height }).toPNG();
          });
          await writeFile(
            join(artifacts, `${appearance}-${viewport.width}x${viewport.height}.png`),
            Buffer.from(bytes),
          );
        }
        await page.keyboard.press("Escape");
      }
    }
    await editor.locator("td").last().click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.focusOffset)).toBe(2);
    // 原生行尾移动通过异步 selectionchange 更新编辑器，下一次手势在浏览器完成这一帧后发出。
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.insertText("补充");
    expect(await editor.locator("td").last().innerText()).toBe("备注\n补充");
    expect(await editor.locator("table").count()).toBe(1);
    const multiline = await save();
    expect(multiline).toContain("备注<br>补充");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.insertText("继续");
    expect(await editor.locator(":scope > p").last().innerText()).toBe("继续后文");
    const final = await save();
    expect(final).toBe(multiline.replace(/后文$/, "继续后文"));
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.locator(".ProseMirror table").waitFor();
    expect(await reopened.locator(".ProseMirror th").count()).toBe(3);
    expect(await reopened.locator(".ProseMirror td").last().innerText()).toBe("备注\n补充");
    expect(await readFile(file, "utf8")).toBe(final);
  } catch (error) {
    app.process().kill("SIGKILL");
    throw error;
  } finally {
    if (!app.process().killed) await app.close();
  }
});
