import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { fidelityScene, visualViewports } from "../fixtures/quality-scenes";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("固定内容在浅深色、长表格和三种窗口中保持可读并输出视觉基线", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-visual-scenes-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const table = [
    "# 长表格",
    "",
    `| ${Array.from({ length: 12 }, (_, index) => `列 ${index + 1}`).join(" | ")} |`,
    `| ${Array(12).fill("---").join(" | ")} |`,
    `| ${Array.from({ length: 12 }, (_, index) => `需要横向阅读的内容 ${index + 1}`).join(" | ")} |`,
  ].join("\n");
  await Promise.all([
    writeFile(join(vault, "思考的边界.md"), fidelityScene),
    writeFile(join(vault, "长表格.md"), table),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "思考的边界.md", filesCollapsed: true }),
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
      `--user-data-dir=${state}`,
      "--no-sandbox",
    ],
    colorScheme: null,
    env: environment,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    await page.locator(".ProseMirror").waitFor();
    const artifacts = process.env.NOUS_QUALITY_ARTIFACTS;
    if (artifacts) await mkdir(artifacts, { recursive: true });
    for (const appearance of ["浅色", "深色"]) {
      await page.getByRole("button", { name: "切换笔记库", exact: true }).click();
      await page.getByRole("button", { name: appearance, exact: true }).click();
      await expect
        .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
        .toBe(appearance === "浅色" ? "light" : "dark");
      await page.keyboard.press("Escape");
      for (const viewport of visualViewports) {
        await app.evaluate(({ BrowserWindow }, { width, height }) => {
          const window = BrowserWindow.getAllWindows()[0];
          if (window === undefined) throw new Error("应用窗口不存在");
          window.setContentSize(width, height);
        }, viewport);
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(viewport.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const editor = page.locator(".ProseMirror");
        expect(await editor.evaluate((element) => getComputedStyle(element).fontSize)).toBe("17px");
        expect(
          await editor.evaluate((element) => element.getBoundingClientRect().width),
        ).toBeLessThanOrEqual(720);
        const checkbox = page.getByRole("checkbox").first();
        expect(
          await checkbox.evaluate((element) => element.getBoundingClientRect().width),
        ).toBeGreaterThanOrEqual(32);
        if (artifacts) {
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
      }
    }
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    await page.getByRole("treeitem", { name: "长表格.md", exact: true }).click();
    await page.getByRole("heading", { name: "长表格", exact: true }).waitFor();
    const grid = page.locator(".ProseMirror table");
    expect(await grid.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(
      await grid
        .locator("td")
        .first()
        .evaluate((cell) => cell.getBoundingClientRect().width),
    ).toBeGreaterThanOrEqual(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // 选中末列时表格必须能滚到目标，正文宽度不随表格增长。
    await grid.locator("td").last().click();
    expect(await grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
