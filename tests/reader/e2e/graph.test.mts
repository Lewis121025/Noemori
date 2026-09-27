import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("关系图谱：全局图谱过滤与点击打开，局部图谱随库变更增量刷新", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-graph-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "甲.md"), "# 甲\n\n见 [[乙]] 与 [[丙]]。\n"),
    writeFile(join(vault, "乙.md"), "回到 [[甲]]。\n"),
    writeFile(join(vault, "丙.md"), "# 丙\n\n终点。\n"),
    writeFile(join(vault, "孤立.md"), "没有链接。\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "甲.md", filesCollapsed: false, leftWidth: 260 },
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
    const documentName = () => page.locator(".document-name").first().textContent();
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "甲.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );

    // Cmd/Ctrl+G 打开全局图谱：四篇笔记、三条有向边。
    await page.keyboard.press("ControlOrMeta+g");
    const dialog = page.getByRole("dialog", { name: "关系图谱" });
    await expect.poll(() => dialog.locator(".stats").textContent()).toBe("4 个节点 · 3 条链接");
    await dialog.getByLabel("孤立笔记").uncheck();
    await expect.poll(() => dialog.locator(".stats").textContent()).toBe("3 个节点 · 3 条链接");
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.count()).toBe(0);

    // 过滤到单个节点：适配视图把它放在画布中央，Worker 布局结束后画出来。
    await page.keyboard.press("ControlOrMeta+g");
    await dialog.getByLabel("过滤图谱").fill("丙");
    await expect.poll(() => dialog.locator(".stats").textContent()).toBe("1 个节点 · 0 条链接");
    const canvas = dialog.locator("canvas");
    await expect.poll(() => dialog.getByText("正在布局…").count()).toBe(0);
    const painted = () =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext("2d");
        if (context === null) return false;
        const center = context.getImageData(element.width / 2, element.height / 2, 1, 1).data;
        const corner = context.getImageData(2, 2, 1, 1).data;
        return center.some((value, index) => value !== corner[index]);
      });
    await expect.poll(painted).toBe(true);
    // 背景取主题色而不是 Canvas 默认的黑色：`light-dark()` 变量必须先解析成具体颜色。
    expect(
      await canvas.evaluate((element: HTMLCanvasElement) => [
        ...element.getContext("2d")!.getImageData(2, 2, 1, 1).data,
      ]),
    ).toEqual([253, 253, 252, 255]);
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("画布没有尺寸");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => dialog.locator(".hovered").textContent()).toBe("丙");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => dialog.count()).toBe(0);
    await expect.poll(documentName).toBe("丙.md");

    // 局部图谱：丙只有甲一条入链；外部新增一篇链接丙的笔记后增量刷新。
    await page.getByText("局部图谱", { exact: true }).click();
    const local = page.getByRole("region", { name: "局部关系图谱" });
    await expect.poll(() => local.locator(".stats").textContent()).toBe("2 个节点 · 1 条链接");
    await writeFile(join(vault, "丁.md"), "引用 [[丙]]。\n");
    await expect.poll(() => local.locator(".stats").textContent()).toBe("3 个节点 · 2 条链接");

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
