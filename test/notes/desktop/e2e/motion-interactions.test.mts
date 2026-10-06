import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { noteAction } from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("普通控件、目录、查找与附件反馈共享动效，减少动态效果即时生效", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-interaction-motion-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source = "# 森林\n\n安静地阅读。\n\n## 林间\n\n保持连续。\n\n### 树影\n\n森林里的文字。\n";
  await Promise.all([
    writeFile(join(vault, "森林.md"), source),
    writeFile(join(vault, "attachments"), "保留现有文件"),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ reader: { vaultRoot: vault, currentPath: "森林.md" } }),
    ),
  ]);
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const app = await electron.launch({
    executablePath,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${state}`,
      "--no-sandbox",
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
      ),
    ),
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(".ProseMirror").waitFor();
    const original = await page.locator(".ProseMirror").elementHandle();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "插入附件…", exact: true }).click();
    await (
      await chooser
    ).setFiles([
      {
        name: "test.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
      },
    ]);
    const notice = page.getByRole("complementary", { name: "附件导入" });
    await expect.poll(() => notice.innerText()).toContain("未导入");
    await expect
      .poll(() => notice.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    expect(await notice.evaluate((element) => getComputedStyle(element).pointerEvents)).not.toBe(
      "none",
    );
    await notice.getByRole("button", { name: "关闭", exact: true }).click();

    const heading = page
      .locator(".outline-sidebar")
      .getByRole("button", { name: "林间", exact: true });
    await heading.focus();
    await page.keyboard.press("Enter");
    expect(
      await heading.evaluate((element) => {
        const animations = element.getAnimations();
        animations.forEach((animation) => animation.pause());
        return animations.length;
      }),
    ).toBeGreaterThan(0);
    // 动画正在播放时切换系统偏好，JS 动效和 CSS 动效都必须立即释放。
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => heading.evaluate((element) => element.getAnimations().length)).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const fold = page
      .locator(".outline-sidebar")
      .getByRole("button", { name: "折叠", exact: true })
      .first();
    await fold.click();
    const unfold = page
      .locator(".outline-sidebar")
      .getByRole("button", { name: "展开", exact: true })
      .first();
    expect(
      await unfold.locator("span").evaluate((element) => element.getAnimations().length),
    ).toBeGreaterThan(0);
    await unfold.click();
    await noteAction(page, "笔记属性…");
    const details = page.locator(".properties");
    await details.locator("summary").click();
    // Chromium 不在 Element.getAnimations 中枚举 details-content 的内部动画；读取真实逐帧高度。
    const heights = await details.evaluate(async (element) => {
      const samples: number[] = [];
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise(requestAnimationFrame);
        samples.push(element.getBoundingClientRect().height);
      }
      return samples;
    });
    expect(heights.at(-1)).toBeGreaterThan(heights[0]!);
    await page.getByRole("textbox", { name: "新属性键", exact: true }).focus();
    expect(
      await page
        .getByRole("textbox", { name: "新属性键", exact: true })
        .evaluate((element) => getComputedStyle(element).boxShadow),
    ).not.toBe("none");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "文内查找", exact: true }).click();
    const query = page.getByRole("searchbox", { name: "查找", exact: true });
    await query.fill("森林");
    await expect.poll(() => page.locator(".search-status").innerText()).toContain("2");
    await page.getByRole("button", { name: "替换选项", exact: true }).click();
    expect(
      await page.locator(".replace-row").evaluate((element) => element.getAnimations().length),
    ).toBeGreaterThan(0);
    await page.getByRole("button", { name: "替换选项", exact: true }).click();
    expect(await page.locator(".replace-row").getAttribute("inert")).not.toBeNull();
    await page.getByRole("button", { name: "关闭查找", exact: true }).click();
    expect(
      await original?.evaluate((element) => element === document.querySelector(".ProseMirror")),
    ).toBe(true);
    await page.getByRole("button", { name: "文件系统", exact: true }).click();
    await page
      .getByRole("grid")
      .getByRole("button", { name: "森林.md", exact: true })
      .click({ button: "right" });
    const menu = page.getByRole("menu", { name: "文件操作", exact: true });
    expect(await menu.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0);
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState === "finished"),
    );
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    await page.keyboard.press("Escape");
    expect(
      await page
        .locator(".file-menu")
        .evaluate((element) => getComputedStyle(element).pointerEvents),
    ).toBe("none");
    expect(await readFile(join(vault, "森林.md"), "utf8")).toBe(source);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
