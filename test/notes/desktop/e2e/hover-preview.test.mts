import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("悬停预览：链接停留后弹出目标小节，移入弹层保持，离开关闭；点击标题打开原文", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-hover-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(join(vault, "notes"), { recursive: true }), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "入口.md"), "# 入口\n\n参见 [[目标#第二节]] 与 [[不存在]]。\n"),
    writeFile(
      join(vault, "notes/目标.md"),
      "# 目标\n\n## 第一节\n\n不该出现。\n\n## 第二节\n\n预览里的正文 $E=mc^2$。%%隐藏注释%%\n\n[继续阅读](./关联.md)\n\n![示意图](image.png)\n\n- [ ] 任务\n",
    ),
    writeFile(join(vault, "notes/关联.md"), "# 关联\n"),
    writeFile(
      join(vault, "notes/image.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "入口.md", filesCollapsed: false, leftWidth: 260 },
        appearance: "light",
        window: null,
      }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  }
  const app = await electron.launch({
    executablePath: executable,
    colorScheme: null,
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
    const ready = (name: string) =>
      page.waitForFunction(
        (expected) =>
          document.querySelector(".document-name")?.textContent === expected &&
          document.querySelector("section[data-pane]")?.hasAttribute("inert") === false,
        name,
      );
    await ready("入口.md");
    const popover = page.locator(".hover-preview");

    await page.locator('.wiki-link[data-wiki-target="目标#第二节"]').hover();
    await popover.waitFor();
    await expect
      .poll(() => popover.locator(".ProseMirror").textContent())
      .toContain("预览里的正文");
    expect(await popover.textContent()).not.toContain("不该出现");
    await popover.locator("mjx-container").waitFor();
    await expect
      .poll(() =>
        popover.locator(".note-image").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    expect(await popover.locator(".task-checkbox").isDisabled()).toBe(true);
    expect(await popover.locator(".comment-inline").isVisible()).toBe(false);

    // 预览内的相对链接以目标笔记所在目录解析，普通单击可继续阅读。
    await popover.getByRole("link", { name: "继续阅读" }).click();
    await ready("关联.md");
    await page.keyboard.press("ControlOrMeta+[");
    await ready("入口.md");
    await page.locator('.wiki-link[data-wiki-target="目标#第二节"]').hover();
    await popover.waitFor();

    // 移入弹层保持打开，移到正文空白处关闭。
    await popover.hover();
    await page.waitForTimeout(400);
    expect(await popover.count()).toBe(1);
    await page.locator(".ProseMirror h1").first().hover();
    await expect.poll(() => popover.count()).toBe(0);

    // 死链只显示原因。
    await page.locator('.wiki-link[data-wiki-target="不存在"]').hover();
    await popover.waitFor();
    await expect.poll(() => popover.textContent()).toContain("目标不存在");

    // 点击弹层标题打开原文。
    await page.locator('.wiki-link[data-wiki-target="目标#第二节"]').hover();
    await expect.poll(() => popover.textContent()).toContain("预览里的正文");
    await popover.getByRole("button", { name: "目标#第二节" }).click();
    await expect.poll(() => page.locator(".document-name").first().textContent()).toBe("目标.md");
    expect(await popover.count()).toBe(0);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
