import { noteAction, openLibrary } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("原生菜单、快捷键和就地源码共用历史，普通输入框保持独立撤销并保真保存", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-history-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  const original = "\uFEFF# 历史验收\r\n\r\n正文 _保留_。\r\n\r\n公式 $x$\r\n";
  const plain = "\uFEFF原文本。\r\n";
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "笔记.md"), original),
    writeFile(join(vault, "文本.txt"), plain),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "笔记.md" }),
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
    const paragraph = editor.locator(":scope > p").first();
    const lineEnd = process.platform === "darwin" ? "Meta+ArrowRight" : "End";
    const historyState = () =>
      app.evaluate(({ Menu }) => {
        const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === "编辑");
        return {
          undo: edit?.submenu?.items.find((item) => item.label === "撤销")?.enabled,
          redo: edit?.submenu?.items.find((item) => item.label === "重做")?.enabled,
        };
      });
    const historyMenu = (label: "撤销" | "重做") =>
      app.evaluate(({ Menu }, name) => {
        const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === "编辑");
        const item = edit?.submenu?.items.find((item) => item.label === name);
        if (!item) throw new Error(`缺少历史菜单：${name}`);
        item.click();
      }, label);
    await paragraph.click();
    await expect.poll(historyState).toEqual({ undo: false, redo: false });
    await page.keyboard.press(lineEnd);
    await page.keyboard.insertText("续写");
    await expect.poll(historyState).toEqual({ undo: true, redo: false });
    await historyMenu("撤销");
    await expect.poll(() => paragraph.innerText()).toBe("正文 保留。");
    await expect.poll(historyState).toEqual({ undo: false, redo: true });
    await historyMenu("撤销");
    expect(await paragraph.innerText()).toBe("正文 保留。");
    await historyMenu("重做");
    await expect.poll(() => paragraph.innerText()).toBe("正文 保留。续写");
    await expect.poll(historyState).toEqual({ undo: true, redo: false });

    await editor.locator(".math-inline").dblclick();
    const source = page.getByLabel("行内公式源码", { exact: true });
    await source.fill("x+y");
    await historyMenu("撤销");
    await expect.poll(() => source.inputValue()).toBe("x");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => source.inputValue()).toBe("x+y");
    // 系统输入控件发出的 beforeinput 也必须进入同一文档历史。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.undo());
    await expect.poll(() => source.inputValue()).toBe("x");
    await historyMenu("重做");
    await expect.poll(() => source.inputValue()).toBe("x+y");
    expect(await source.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Escape");

    await paragraph.click();
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "插入链接", exact: true });
    const target = dialog.getByLabel("链接目标");
    await target.waitFor();
    await expect.poll(historyState).toEqual({ undo: false, redo: false });
    await target.fill("草稿.md");
    await expect.poll(historyState).toEqual({ undo: true, redo: false });
    await historyMenu("撤销");
    await expect.poll(() => target.inputValue()).toBe("");
    await expect.poll(historyState).toEqual({ undo: false, redo: true });
    await historyMenu("重做");
    await expect.poll(() => target.inputValue()).toBe("草稿.md");
    expect(await paragraph.innerText()).toBe("正文 保留。续写");
    await page.keyboard.press("Escape");
    await expect.poll(historyState).toEqual({ undo: true, redo: false });

    await noteAction(page, "文内查找");
    const query = page
      .getByRole("form", { name: "文内查找替换" })
      .getByLabel("查找", { exact: true });
    await query.fill("保留");
    await historyMenu("撤销");
    await expect.poll(() => query.inputValue()).toBe("");
    await historyMenu("重做");
    await expect.poll(() => query.inputValue()).toBe("保留");
    await page.getByRole("button", { name: "替换选项", exact: true }).click();
    const replacement = page.getByLabel("替换为", { exact: true });
    await replacement.click();
    await expect.poll(historyState).toEqual({ undo: false, redo: false });
    // 即使系统沿旧记录发出 historyUndo，也只能作用于当前输入框。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.undo());
    expect(await query.inputValue()).toBe("保留");
    expect(await replacement.inputValue()).toBe("");
    expect(await replacement.evaluate((element) => element === document.activeElement)).toBe(true);
    await replacement.fill("新内容");
    await historyMenu("撤销");
    await expect.poll(() => replacement.inputValue()).toBe("");
    expect(await query.inputValue()).toBe("保留");
    await query.click();
    await historyMenu("撤销");
    await expect.poll(() => query.inputValue()).toBe("");
    await historyMenu("重做");
    await expect.poll(() => query.inputValue()).toBe("保留");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
    const composing = await query.inputValue();
    await expect.poll(historyState).toEqual({ undo: false, redo: false });
    await historyMenu("撤销");
    await historyMenu("重做");
    expect(await query.inputValue()).toBe(composing);
    await cdp.send("Input.insertText", { text: "中文" });
    await historyMenu("撤销");
    await expect.poll(() => query.inputValue()).toBe("保留");
    await historyMenu("重做");
    await expect.poll(() => query.inputValue()).toBe(composing);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+s");
    const saved = original.replace("。", "。续写").replace("$x$", "$x+y$");
    await expect.poll(() => readFile(join(vault, "笔记.md"), "utf8")).toBe(saved);

    await openLibrary(page);
    const note = page
      .getByRole("region", { name: "文件系统", exact: true })
      .getByRole("button", { name: "笔记.md", exact: true });
    await note.focus();
    await page.keyboard.press("F2");
    const filename = page.getByRole("textbox", { name: "重命名文件", exact: true });
    await filename.fill("放弃的新名称.md");
    await historyMenu("撤销");
    await expect.poll(() => filename.inputValue()).toBe("笔记.md");
    await expect.poll(historyState).toEqual({ undo: false, redo: true });
    await page.keyboard.press("Escape");
    await note.focus();
    await page.keyboard.press("F2");
    await filename.waitFor();
    await expect.poll(historyState).toEqual({ undo: false, redo: false });
    await historyMenu("重做");
    expect(await filename.inputValue()).toBe("笔记.md");
    await page.keyboard.press("Escape");

    await page
      .getByRole("region", { name: "文件系统", exact: true })
      .getByRole("button", { name: "文本.txt", exact: true })
      .dblclick();
    const code = page.locator(".cm-content");
    await code.locator(".cm-line").first().click();
    await expect.poll(historyState).toEqual({ undo: false, redo: false });
    await page.keyboard.press(lineEnd);
    await page.keyboard.insertText("续写");
    await historyMenu("撤销");
    await expect.poll(() => code.textContent()).toBe("\uFEFF原文本。");
    await expect.poll(historyState).toEqual({ undo: false, redo: true });
    await historyMenu("重做");
    await expect.poll(() => code.textContent()).toBe("\uFEFF原文本。续写");
    await expect.poll(historyState).toEqual({ undo: true, redo: false });
    await page.keyboard.press("ControlOrMeta+f");
    const codeQuery = page.locator(".cm-search").getByLabel("查找", { exact: true });
    await codeQuery.waitFor();
    await expect.poll(historyState).toEqual({ undo: false, redo: false });
    await codeQuery.fill("原文本");
    await historyMenu("撤销");
    await expect.poll(() => codeQuery.inputValue()).toBe("");
    await expect.poll(historyState).toEqual({ undo: false, redo: true });
    await historyMenu("重做");
    await expect.poll(() => codeQuery.inputValue()).toBe("原文本");
    expect(await code.textContent()).toBe("\uFEFF原文本。续写");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "文本.txt"), "utf8"))
      .toBe(plain.replace("。", "。续写"));
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await expect
      .poll(() => reopened.locator(".cm-content").textContent())
      .toBe("\uFEFF原文本。续写");
    await expect.poll(historyState).toEqual({ undo: false, redo: false });
    await openLibrary(reopened);
    await reopened
      .getByRole("region", { name: "文件系统", exact: true })
      .getByRole("button", { name: "笔记.md", exact: true })
      .dblclick();
    await reopened.getByRole("heading", { name: "历史验收" }).waitFor();
    expect(await reopened.locator(".math-inline").getAttribute("data-math-tex")).toBe("x+y");
    expect(await readFile(join(vault, "笔记.md"))).toEqual(Buffer.from(saved));
  } catch (error) {
    app.process().kill("SIGKILL");
    throw error;
  } finally {
    if (!app.process().killed) await app.close();
  }
});
