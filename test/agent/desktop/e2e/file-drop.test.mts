import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { openLibrary } from "../../../notes/desktop/support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("笔记库多文件与外部文件拖入独立对话，原文保留，草稿重载恢复且附件可预览移除", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-agent-file-drop-"));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const vault = join(directory, "vault"), state = join(directory, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  await Promise.all([
    writeFile(join(vault, "资料.md"), "# 资料\n\n文件拖入验收😀。\n"),
    writeFile(join(vault, "补充.md"), "# 补充\n\n第二份文件。\n"),
    writeFile(join(state, "session.json"), JSON.stringify({ appearance: "light", reader: { vaultRoot: vault, currentPath: "资料.md" } })),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("Electron 未安装");
  const app = await electron.launch({ executablePath: executable, args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`] });
  context.onTestFinished(() => app.close());
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLibrary(page);
  const conversation = await page.evaluate(() => window.noemori.agent.create(null, "文件拖入验收"));
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  const composer = page.locator(".composer");
  await composer.waitFor();
  const prompt = page.getByRole("textbox", { name: "Agent 用户任务", exact: true });
  await prompt.fill("结合这几份资料");
  const library = page.locator(".file-sidebar:not(.right)");
  const first = library.locator('button[data-path="资料.md"]');
  await first.click();
  await library.locator('button[data-path="补充.md"]').click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await first.dragTo(composer);
  await expect.poll(async () => (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id)).draftAttachments?.length).toBe(2);
  expect(await prompt.inputValue()).toBe("结合这几份资料");
  expect(await composer.locator('[aria-label="引用内容"]').count()).toBe(0);
  expect(await readFile(join(vault, "资料.md"), "utf8")).toBe("# 资料\n\n文件拖入验收😀。\n");
  expect(await readFile(join(vault, "补充.md"), "utf8")).toBe("# 补充\n\n第二份文件。\n");

  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["系统文件正文"], "系统资料.txt", { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"])
      element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await composer.getByRole("button", { name: "预览附件：系统资料.txt", exact: true }).waitFor();
  await expect.poll(async () => (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id)).draftAttachments?.length).toBe(3);
  await page.reload();
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await composer.getByRole("button", { name: "预览附件：资料.md", exact: true }).waitFor();
  expect(await prompt.inputValue()).toBe("结合这几份资料");

  for (const appearance of ["light", "dark"] as const) {
    await page.evaluate((value) => window.noemori.app.appearanceSet(value), appearance);
    await page.emulateMedia({ colorScheme: appearance, reducedMotion: appearance === "dark" ? "reduce" : "no-preference" });
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), appearance === "dark" ? { width: 640, height: 480 } : { width: 1100, height: 720 });
    await composer.getByRole("button", { name: "预览附件：资料.md", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "附件预览", exact: true });
    await expect.poll(() => preview.locator("pre").textContent()).toBe("# 资料\n\n文件拖入验收😀。\n");
    expect(await preview.evaluate((element) => { const bounds = element.getBoundingClientRect(); return bounds.x >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight; })).toBe(true);
    const captures = process.env["NOEMORI_FILE_DROP_SCREENSHOTS"];
    if (captures) {
      await mkdir(captures, { recursive: true });
      await page.screenshot({ path: join(captures, `file-drop-${appearance}.png`), scale: "css", animations: "disabled" });
    }
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
  }
  await composer.getByRole("button", { name: "移除附件：系统资料.txt", exact: true }).click();
  await expect.poll(async () => (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id)).draftAttachments?.length).toBe(2);
  expect(await prompt.inputValue()).toBe("结合这几份资料");
  expect(errors).toEqual([]);
});
