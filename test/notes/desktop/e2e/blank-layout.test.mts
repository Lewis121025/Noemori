import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("连续回车的空白布局在保存、源码切换和重启后保持一致", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-blank-layout-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "空白.md"), ""),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "空白.md" }),
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
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => readFile(join(vault, "空白.md"), "utf8")).toBe("\n");
    expect(await editor.locator(":scope > p").count()).toBe(2);
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("正文");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    const saved = "\n\n正文\n\n\n";
    await expect.poll(() => readFile(join(vault, "空白.md"), "utf8")).toBe(saved);
    expect(await editor.locator(":scope > p").count()).toBe(5);
    expect(await page.getByRole("button", { name: "处理保存问题", exact: true }).count()).toBe(0);
    expect(
      await page.evaluate(async () => (await window.noemori.reader.fileSnapshot("空白.md")).draft),
    ).toBeNull();

    await page.keyboard.press("ControlOrMeta+e");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.press("ControlOrMeta+e");
    await editor.waitFor();
    expect(await editor.locator(":scope > p").count()).toBe(5);
    await page.keyboard.insertText("末段");
    await page.keyboard.press("ControlOrMeta+s");
    const continued = "\n\n正文\n\n\n末段";
    await expect.poll(() => readFile(join(vault, "空白.md"), "utf8")).toBe(continued + "\n");

    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    reopened.on("pageerror", (error) => errors.push(error.message));
    await reopened.locator(".ProseMirror").waitFor();
    expect(await reopened.locator(".ProseMirror > p").allTextContents()).toEqual([
      "",
      "",
      "正文",
      "",
      "末段",
    ]);
    expect(await readFile(join(vault, "空白.md"), "utf8")).toBe(continued + "\n");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
