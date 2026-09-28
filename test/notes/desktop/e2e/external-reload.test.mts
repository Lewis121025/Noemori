import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron, type Locator } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("外部更新长文后保留反向选区、阅读位置和焦点，继续输入使用新的磁盘基准", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-external-reload-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  const selected = "当前想法 👩‍💻 é 继续写作。";
  const paragraphs = Array.from({ length: 100 }, (_, index) =>
    index === 50 ? selected : `第 ${index + 1} 段，有自己的内容与位置。`,
  );
  const original =
    "\uFEFF# 阅读上下文\r\n\r\n" + paragraphs.join("\r\n\r\n") + "\r\n\r\n$$\r\nx+y+z\r\n$$\r\n";
  const codeSource = Array.from({ length: 120 }, (_, index) =>
    index === 60 ? "中文 👩‍💻 é 继续写作。" : `line ${index + 1}`,
  ).join("\r\n");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "长文.md"), original),
    writeFile(join(vault, "文本.txt"), codeSource),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "长文.md" }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
      "--no-sandbox",
    ],
    env: environment,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    const paragraph = editor.locator("p").filter({ hasText: selected });
    await expect
      .poll(() =>
        editor.evaluate((element) => element.isConnected && element.closest("[inert]") === null),
      )
      .toBe(true);
    const endKey = process.platform === "darwin" ? "Meta+ArrowRight" : "End";
    /**
     * 以接近真人的节奏从行尾反向选中五个字符并返回选中文本。
     *
     * ProseMirror/CodeMirror 在把选区同步回 DOM 后有约 50ms 的选区同步抑制
     * 窗口；CDP 的零间隔连发会让末尾按键的 selectionchange 被吞掉，编辑器
     * 状态落后于 DOM 选区，重载恢复时选区变短（历史上本用例的高频抖动源）。
     * 键间等待让每次按键独立成同步回合，收尾再补发一次 selectionchange 兜底。
     */
    const selectTrailingFive = async (target: Locator): Promise<string> => {
      await target.click();
      await page.keyboard.press(endKey);
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Shift+ArrowLeft");
        await page.waitForTimeout(60);
      }
      await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
      return page.evaluate(() => window.getSelection()?.toString() ?? "");
    };
    await expect
      .poll(() => selectTrailingFive(paragraph), { timeout: 10000, interval: 50 })
      .toBe("继续写作。");
    const before = await page.evaluate(() => {
      const selection = window.getSelection();
      return {
        text: selection?.toString(),
        anchor: selection?.anchorOffset,
        head: selection?.focusOffset,
      };
    });
    expect(before.text).toBe("继续写作。");
    const top = (await paragraph.boundingBox())?.y;
    if (top === undefined) throw new Error("缺少阅读位置");
    const external = original
      .replace("# 阅读上下文", "# 阅读上下文\r\n\r\n外部新增的第一段。")
      .replace("第 100 段", "外部更新的末段");
    await writeFile(join(vault, "长文.md"), external);
    await editor.getByText("外部新增的第一段。", { exact: true }).waitFor({ state: "attached" });
    await expect
      .poll(() => editor.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = window.getSelection();
          return {
            text: selection?.toString(),
            anchor: selection?.anchorOffset,
            head: selection?.focusOffset,
          };
        }),
      )
      .toEqual(before);
    expect(Math.abs(((await paragraph.boundingBox())?.y ?? 0) - top)).toBeLessThanOrEqual(2);
    expect(await page.locator(".save-status").textContent()).toBe("已保存");
    await page.keyboard.insertText("接着写。");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "长文.md"), "utf8"))
      .toBe(external.replace("继续写作。", "接着写。"));

    const saved = await readFile(join(vault, "长文.md"), "utf8");
    await page.keyboard.press("ControlOrMeta+f");
    const query = page.getByRole("searchbox", { name: "查找", exact: true });
    await query.fill("外部");
    await query.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
    await query.press("Shift+ArrowRight");
    expect(
      await query.evaluate((element) =>
        element instanceof HTMLInputElement ? [element.selectionStart, element.selectionEnd] : null,
      ),
    ).toEqual([0, 1]);
    const searched = saved + "\r\n外部又更新了末尾。\r\n";
    await writeFile(join(vault, "长文.md"), searched);
    await editor.getByText("外部又更新了末尾。", { exact: true }).waitFor({ state: "attached" });
    expect(await query.inputValue()).toBe("外部");
    expect(await query.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(
      await query.evaluate((element) =>
        element instanceof HTMLInputElement ? [element.selectionStart, element.selectionEnd] : null,
      ),
    ).toEqual([0, 1]);
    await query.press("Escape");

    const writing = editor.locator("p").filter({ hasText: "接着写。" });
    await writing.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.press("ControlOrMeta+k");
    const link = page.getByRole("dialog", { name: "插入链接", exact: true });
    const target = link.getByLabel("链接目标");
    await target.fill("尚未提交的链接目标");
    const linked = searched.replace("# 阅读上下文", "# 外部更新标题");
    await writeFile(join(vault, "长文.md"), linked);
    await editor
      .getByRole("heading", { name: "外部更新标题", exact: true })
      .waitFor({ state: "attached" });
    expect(await link.isVisible()).toBe(true);
    expect(await target.inputValue()).toBe("尚未提交的链接目标");
    expect(await target.evaluate((element) => element === document.activeElement)).toBe(true);
    await target.press("Escape");
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);

    await editor.locator(".math-block").click();
    await page.keyboard.press("Enter");
    const formula = page.getByRole("textbox", { name: "块级公式源码" });
    await formula.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
    await formula.press("ArrowRight");
    await formula.press("ArrowRight");
    await formula.press("Shift+ArrowRight");
    await writeFile(join(vault, "长文.md"), linked.replace("x+y+z", "a+x+y+z"));
    await expect.poll(() => formula.inputValue()).toBe("a+x+y+z");
    expect(await formula.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(
      await formula.evaluate((element) =>
        element instanceof HTMLTextAreaElement
          ? element.value.slice(element.selectionStart, element.selectionEnd)
          : null,
      ),
    ).toBe("y");
    await formula.press("Escape");

    await page.getByRole("treeitem", { name: "文本.txt", exact: true }).click();
    const code = page.locator(".cm-editor");
    const codeContent = code.locator(".cm-content");
    await expect
      .poll(() =>
        codeContent.evaluate(
          (element) => element.isConnected && element.closest("[inert]") === null,
        ),
      )
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+f");
    await code.locator('input[name="search"]').fill("继续写作。");
    await code.locator('input[name="search"]').press("Enter");
    await code.locator('input[name="search"]').press("Escape");
    const codeParagraph = code.locator(".cm-line").filter({ hasText: "继续写作。" });
    await expect
      .poll(() => selectTrailingFive(codeParagraph), { timeout: 10000, interval: 50 })
      .toBe("继续写作。");
    const codeTop = (await codeParagraph.boundingBox())?.y;
    if (codeTop === undefined) throw new Error("文本位置不存在");
    const codeExternal = "新增行\r\n" + codeSource + "\r\n末尾新增行";
    const reloadCode = async (source: string) => {
      const previous = await code.locator(".cm-content").elementHandle();
      if (previous === null) throw new Error("文本编辑器未挂载");
      await writeFile(join(vault, "文本.txt"), source);
      await page.waitForFunction((element) => !element.isConnected, previous);
      await previous.dispose();
      await code.locator(".cm-content").waitFor();
    };
    await reloadCode(codeExternal);
    expect(
      await code.locator(".cm-content").evaluate((element) => element === document.activeElement),
    ).toBe(true);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("继续写作。");
    await expect
      .poll(async () => Math.abs(((await codeParagraph.boundingBox())?.y ?? 0) - codeTop))
      .toBeLessThanOrEqual(2);
    await page.keyboard.insertText("新输入。");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "文本.txt"), "utf8"))
      .toBe(codeExternal.replace("继续写作。", "新输入。"));
    await page.keyboard.press("ControlOrMeta+f");
    const codeQuery = code.locator('input[name="search"]');
    await codeQuery.fill("新增");
    const codeSaved = await readFile(join(vault, "文本.txt"), "utf8");
    await reloadCode(codeSaved + "\r\n再次更新");
    await expect.poll(() => codeQuery.inputValue()).toBe("新增");
    expect(await codeQuery.evaluate((element) => element === document.activeElement)).toBe(true);
    const fileQuery = page.getByRole("navigation", { name: "文件列表" }).getByRole("searchbox");
    await fileQuery.fill("文本");
    await reloadCode(codeSaved + "\r\n最后一次外部更新");
    expect(await fileQuery.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await fileQuery.inputValue()).toBe("文本");
    expect(errors).toEqual([]);
  } catch (error) {
    app.process().kill("SIGKILL");
    throw error;
  } finally {
    if (!app.process().killed) await app.close();
  }
});
