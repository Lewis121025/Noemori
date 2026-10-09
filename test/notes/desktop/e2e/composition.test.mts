import { confirmNewEntry } from "../support/workspace-actions";
import { noteAction } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

// CDP 驱动 Chromium 的真实 composition 生命周期；macOS 输入法候选窗仍需独立系统验收。
test("组词确认和取消不提交弹窗、不跳转查找、不退出源码；结束后正常保存重开", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-composition-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(
      join(vault, "输入.md"),
      "# 输入验收\n\n中文目标，继续写作。中文目标。\n\n公式 $x+y$\n",
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "输入.md" }),
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
      env: environment,
    });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    const cdp = await page.context().newCDPSession(page);
    const compose = (text: string) =>
      cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    const commit = (text: string) => cdp.send("Input.insertText", { text });

    await page.keyboard.press("ControlOrMeta+Shift+f");
    const fileSearch = page.getByRole("searchbox", { name: "搜索笔记库" });
    await fileSearch.fill("");
    await compose("输入");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowDown");
    expect(await fileSearch.inputValue()).toBe("输入");
    expect(await fileSearch.evaluate((element) => element === document.activeElement)).toBe(true);
    await commit("输入");
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    expect(await fileSearch.inputValue()).toBe("");

    // 组词结束后通过快捷键新建文档，继续验证正文输入。
    await page.keyboard.press("ControlOrMeta+n");
    await confirmNewEntry(page);
    await expect.poll(() => page.locator(".document-name").textContent()).toBe("未命名.md");
    await noteAction(page, "重命名…");
    const entry = page.getByRole("dialog", { name: "重命名", exact: true });
    await entry.getByLabel("文件名", { exact: true }).fill("");
    await compose("中文新笔记");
    for (const key of ["Enter", "Escape"]) {
      await page.keyboard.press(key);
      expect(await entry.isVisible()).toBe(true);
      expect(await entry.getByRole("alert").count()).toBe(0);
    }
    await commit("中文新笔记");
    await page.keyboard.insertText(".md");
    await page.keyboard.press("Enter");
    await entry.waitFor({ state: "hidden" });
    await expect.poll(() => page.locator(".document-name").textContent()).toBe("中文新笔记.md");
    await editor.click();
    await page.keyboard.insertText("保留正文");
    await page.keyboard.press("ControlOrMeta+k");
    const link = page.getByRole("dialog", { name: "插入链接", exact: true });
    await link.getByLabel("链接目标").fill("");
    await compose("输入");
    for (const key of ["Enter", "Escape"]) {
      await page.keyboard.press(key);
      expect(await link.isVisible()).toBe(true);
      expect(await editor.locator(".wiki-link").count()).toBe(0);
    }
    await commit("输入.md");
    await link.getByLabel("显示文字").fill("中文链接");
    await page.keyboard.press("Enter");
    await link.waitFor({ state: "hidden" });
    expect(await editor.locator(".wiki-link").innerText()).toBe("中文链接");
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.getByRole("button", { name: "文件与对话", exact: true }).click();
    await page.locator('.library [data-path="输入.md"]').dblclick();
    await page.getByRole("heading", { name: "输入验收" }).waitFor();

    await noteAction(page, "文内查找");
    const search = page.getByRole("form", { name: "文内查找替换" });
    await search.getByLabel("查找", { exact: true }).fill("");
    await compose("中文目标");
    await page.keyboard.press("Enter");
    expect(await editor.locator(".ProseMirror-active-search-match").count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(await search.isVisible()).toBe(true);
    await commit("中文目标");
    await page.keyboard.press("Enter");
    expect(await editor.locator(".ProseMirror-active-search-match").count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await search.isVisible()).toBe(false);
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);

    await editor.locator(".math-inline").dblclick();
    const source = page.getByLabel("行内公式源码", { exact: true });
    await source.fill("");
    await compose("中文");
    for (const key of ["Enter", "Escape", "ArrowLeft", "ArrowRight"]) {
      await page.keyboard.press(key);
      expect(await source.isVisible()).toBe(true);
      expect(await source.evaluate((element) => element === document.activeElement)).toBe(true);
    }
    await commit("x-y");
    await page.keyboard.press("Enter");
    expect(await source.isVisible()).toBe(false);
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForFunction(
      () => document.querySelector(".save-status")?.textContent === "已保存",
    );
    const saved = await readFile(join(vault, "输入.md"), "utf8");
    expect(saved).toContain("$x-y$");
    expect(await readFile(join(vault, "中文新笔记.md"), "utf8")).toContain(
      "保留正文[[输入.md|中文链接]]",
    );
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("heading", { name: "输入验收" }).waitFor();
    expect(await reopened.locator(".math-inline").getAttribute("data-math-tex")).toBe("x-y");
    expect(await readFile(join(vault, "输入.md"), "utf8")).toBe(saved);
  } finally {
    // 正常关闭与重开已在上方验收；失败清理不能再次等保存门禁，否则会掩盖原始断言。
    app.process().kill("SIGKILL");
  }
});
