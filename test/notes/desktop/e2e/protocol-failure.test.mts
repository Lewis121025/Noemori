import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("错误保存确认经过真实 IPC 后保留编辑、阻止关闭，并给出可恢复提示", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-protocol-failure-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  const original = "\uFEFF# 保存确认\r\n\r\n原文 _保留_。\r\n";
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "笔记.md"), original),
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const paragraph = page.locator(".ProseMirror > p");
    await paragraph.waitFor();
    const attempts = await app.evaluateHandle(({ ipcMain }) => {
      const state = { count: 0 };
      ipcMain.removeHandler("reader.file.write");
      ipcMain.handle("reader.file.write", () => {
        state.count += 1;
        return { status: "unknown", warning: null };
      });
      return state;
    });
    await paragraph.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.insertText("这些编辑不能被当作已保存。");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => page.locator(".save-status").textContent()).toBe("保存失败");
    expect(await paragraph.innerText()).toBe("原文 保留。这些编辑不能被当作已保存。");
    await page.getByRole("button", { name: "处理保存问题", exact: true }).click();
    const notice = page.getByRole("region", { name: "保存需要处理" });
    await notice.getByText("查看详细原因", { exact: true }).click();
    expect(await notice.innerText()).toContain("无法确认保存结果，当前编辑仍保留");
    const previousAttempts = await attempts.evaluate((state) => state.count);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect
      .poll(() => attempts.evaluate((state) => state.count))
      .toBeGreaterThan(previousAttempts);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await paragraph.innerText()).toContain("这些编辑不能被当作已保存。");
    expect(await readFile(join(vault, "笔记.md"), "utf8")).toBe(original);
    expect(errors).toEqual([]);
    await attempts.dispose();
  } finally {
    // 本用例故意让保存始终失败；只终止自己的临时实例，不能绕过产品关闭门禁。
    const child = app.process();
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  }
});
