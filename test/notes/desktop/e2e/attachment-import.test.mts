import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("选择、重试、粘贴和拖入附件，经保存与重启仍使用本地原始文件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-attachment-import-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  // macOS / Linux 的既有目录可包含反斜杠；导入、预览和重启均须保留这一文件身份。
  const folderName = process.platform === "win32" ? "资料" : "资料\\原稿";
  const folder = join(vault, folderName);
  await Promise.all([mkdir(folder, { recursive: true }), mkdir(userData)]);
  const note = join(folder, "笔记.md");
  const source = "\uFEFF# 附件\r\n\r\n前文 __保留__\r\n\r\n正文\r\n\r\n后文 _原样_";
  const svg = await readFile(new URL("../fixtures/preview.svg", import.meta.url));
  const pdf = await readFile(new URL("../fixtures/preview.pdf", import.meta.url));
  await Promise.all([
    writeFile(note, source),
    writeFile(join(folder, "attachments"), "同名文件必须保留"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        vaultRoot: vault,
        currentPath: `${folderName}/笔记.md`,
        filesCollapsed: true,
      }),
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
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("缺少主窗口");
      window.setContentSize(640, 480);
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    await editor
      .locator("p")
      .filter({ hasText: /^正文$/ })
      .click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.focusOffset)).toBe(2);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const choose = async (files: { name: string; mimeType: string; buffer: Buffer }[]) => {
      await page
        .locator(".pane-column.active")
        .getByRole("toolbar", { name: "编辑工具栏", exact: true })
        .waitFor();
      const panel = page
        .locator(".pane-column.active")
        .getByRole("toolbar", { name: "编辑工具栏", exact: true });
      const bounds = await panel.boundingBox();
      const lastAction = await panel
        .getByRole("button", { name: "重做", exact: true })
        .boundingBox();
      if (!bounds || !lastAction) throw new Error("格式操作不可见");
      expect(lastAction.y + lastAction.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      expect(await panel.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true,
      );
      await panel.getByRole("button", { name: "插入", exact: true }).click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "插入附件…", exact: true }).click();
      await (await chooser).setFiles(files);
    };
    await choose([{ name: "图片 #1.svg", mimeType: "image/svg+xml", buffer: svg }]);
    const notice = page.getByRole("complementary", { name: "附件导入" });
    await expect.poll(() => notice.innerText()).toContain("未导入");
    expect(await notice.innerText()).toContain("attachments 已被文件占用");
    expect(await notice.innerText()).not.toContain("reader.attachment.import");
    expect(await readFile(join(folder, "attachments"), "utf8")).toBe("同名文件必须保留");
    expect(await readFile(note, "utf8")).toBe(source);
    await rename(join(folder, "attachments"), join(folder, "原有文件"));
    await notice.getByRole("button", { name: "重试剩余附件" }).click();
    await page.waitForFunction(() => {
      const image = document.querySelector(".note-image");
      return image instanceof HTMLImageElement && image.naturalWidth === 1200;
    });
    expect(await readFile(join(folder, "attachments/图片 #1.svg"))).toEqual(svg);
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);

    await choose([{ name: "图片 #1.svg", mimeType: "image/svg+xml", buffer: svg }]);
    await expect.poll(() => editor.locator(".note-image").count()).toBe(2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => editor.locator(".note-image").count()).toBe(1);
    expect(await readFile(join(folder, "attachments/图片 #1 (1).svg"))).toEqual(svg);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => editor.locator(".note-image").count()).toBe(2);

    // 文件选择器从原生菜单进入同一流程；取消保持正文与焦点。
    const menuChooser = page.waitForEvent("filechooser");
    await app.evaluate(({ Menu }) => {
      const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === "编辑");
      const insert = edit?.submenu?.items.find((item) => item.label === "插入附件…");
      if (!insert) throw new Error("缺少附件菜单");
      insert.click();
    });
    await (await menuChooser).setFiles([]);
    expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);

    // Chromium 的真实 File / DataTransfer 穿过粘贴和拖入事件，不调用编辑器私有状态。
    await editor.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array([80, 75, 0, 255])], "资料.zip", { type: "application/zip" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    });
    await editor.getByRole("link", { name: "资料.zip" }).waitFor();
    const paragraph = editor.locator("p").last();
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.evaluate(
      (element, bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(bytes)], "报告.pdf", { type: "application/pdf" }),
        );
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX: rect.left + 8,
            clientY: rect.top + 10,
          }),
        );
      },
      [...pdf],
    );
    await page.getByRole("button", { name: "打开附件", exact: true }).waitFor();
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => page.locator(".save-status").textContent()).toBe("已保存");
    const saved = await readFile(note, "utf8");
    expect(saved.startsWith("\uFEFF# 附件\r\n\r\n前文 __保留__\r\n\r\n")).toBe(true);
    expect(saved).toContain("./attachments/%E5%9B%BE%E7%89%87%20%231.svg");
    expect(saved).toContain("./attachments/%E6%8A%A5%E5%91%8A.pdf");
    expect(await readFile(join(folder, "attachments/报告.pdf"))).toEqual(pdf);
    expect(await readFile(join(folder, "attachments/资料.zip"))).toEqual(
      Buffer.from([80, 75, 0, 255]),
    );
    expect((await readdir(join(folder, "attachments"))).length).toBe(4);
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.locator(".ProseMirror .note-image").first().waitFor();
    expect(await reopened.locator(".ProseMirror .note-image").count()).toBe(2);
    expect(await reopened.getByRole("link", { name: "资料.zip" }).count()).toBe(1);
    expect(await readFile(note, "utf8")).toBe(saved);
  } catch (error) {
    app.process().kill("SIGKILL");
    throw error;
  } finally {
    if (!app.process().killed) await app.close();
  }
});
