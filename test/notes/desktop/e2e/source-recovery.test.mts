import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("无法保真保存的编辑在进程退出后恢复，修正后只修改必要源码", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-source-recovery-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  const original = "\uFEFF# 恢复验收\r\n\r\n正文 _格式保留_ $x$ 结尾\r\n";
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "恢复.md"), original),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "恢复.md" }),
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
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("heading", { name: "恢复验收" }).waitFor();
    await page.locator(".math-inline").dblclick();
    const field = page.getByLabel("行内公式源码", { exact: true });
    await field.fill("");
    const beforeFailure = await page.getByRole("heading", { name: "恢复验收" }).boundingBox();
    if (beforeFailure === null) throw new Error("正文标题不可见");
    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForFunction(
      () => document.querySelector(".save-status")?.textContent === "保存失败",
    );
    const notice = page.getByRole("region", { name: "保存需要处理" });
    expect((await page.getByRole("heading", { name: "恢复验收" }).boundingBox())?.y).toBe(
      beforeFailure.y,
    );
    expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await page.locator("#workspace-feedback").isVisible()).toBe(false);
    const feedback = page.getByRole("button", { name: "处理保存问题", exact: true });
    // 同一任务内执行原生点击并检查默认行为，避免异步 toggle 恰好先执行而掩盖焦点空档。
    expect(
      await feedback.evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error("消息入口不是按钮");
        button.click();
        return document.activeElement?.getAttribute("aria-label");
      }),
    ).toBe("关闭消息面板");
    await page.keyboard.press("Escape");
    expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
    await feedback.click();
    await expect.poll(() => notice.textContent()).toContain("已写入本地恢复记录");
    expect(await notice.getByRole("button", { name: "另存为副本" }).count()).toBe(0);
    expect(await readFile(join(vault, "恢复.md"), "utf8")).toBe(original);
    await page.keyboard.press("Escape");
    await expect
      .poll(() => field.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.insertText("后来输入");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.noemori.reader.fileSnapshot("恢复.md")).draft?.editor),
      )
      .toContain("后来输入");
    expect(await readFile(join(vault, "恢复.md"), "utf8")).toBe(original);

    // 故障注入：直接结束隔离测试进程，不执行正常关闭冲刷。
    const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
    app.process().kill("SIGKILL");
    await exited;
    app = await launch();
    const recovered = await app.firstWindow();
    recovered.on("pageerror", (error) => errors.push(error.message));
    await recovered.getByRole("heading", { name: "恢复验收" }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(640, 480));
    await recovered.getByRole("button", { name: "收起文件栏", exact: true }).click();
    const beforeRepair = await recovered.getByRole("heading", { name: "恢复验收" }).boundingBox();
    expect(await recovered.locator(".ProseMirror").innerText()).toContain("后来输入");
    await recovered.getByRole("button", { name: "处理保存问题", exact: true }).click();
    expect(await recovered.getByRole("region", { name: "保存需要处理" }).textContent()).toContain(
      "已从本地恢复",
    );
    await recovered.getByRole("button", { name: "关闭消息面板", exact: true }).click();
    const resume = recovered.getByRole("button", { name: "补充公式", exact: true });
    await resume.focus();
    await recovered.keyboard.press("Enter");
    const restoredField = recovered.getByLabel("行内公式源码", { exact: true });
    await restoredField.waitFor();
    expect(await restoredField.inputValue()).toBe("");
    await restoredField.fill("x+y");
    await recovered.keyboard.press("Enter");
    await recovered.keyboard.press("ControlOrMeta+s");
    await recovered.waitForFunction(
      () => document.querySelector(".save-status")?.textContent === "已保存",
    );
    expect((await recovered.getByRole("heading", { name: "恢复验收" }).boundingBox())?.y).toBe(
      beforeRepair?.y,
    );
    const saved = original.replace("$x$", "$x+y$").replace("结尾", "结尾后来输入");
    expect(await readFile(join(vault, "恢复.md"), "utf8")).toBe(saved);
    expect(
      await recovered.evaluate(
        async () => (await window.noemori.reader.fileSnapshot("恢复.md")).draft,
      ),
    ).toBeNull();
    expect(await recovered.getByRole("region", { name: "保存需要处理" }).count()).toBe(0);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("heading", { name: "恢复验收" }).waitFor();
    expect(await reopened.locator(".math-inline").getAttribute("data-math-tex")).toBe("x+y");
    expect(await reopened.locator(".ProseMirror").innerText()).toContain("后来输入");
    expect(errors).toEqual([]);
  } finally {
    app.process().kill("SIGKILL");
  }
});
