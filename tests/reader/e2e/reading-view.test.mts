import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("阅读视图：只读、隐藏注释、单击跳转、任务可勾选，源码与阅读互切并随会话记住", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-reading-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const source = "# 阅读\n\n正文 %%私下的注释%% 结尾。\n\n- [ ] 待办\n\n见 [[目标]]。\n";
  await Promise.all([
    writeFile(join(vault, "阅读.md"), source),
    writeFile(join(vault, "目标.md"), "# 目标\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "阅读.md", filesCollapsed: false, leftWidth: 260 },
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
  const launch = () =>
    electron.launch({
      executablePath: executable,
      colorScheme: null,
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
    const ready = (name: string) =>
      page.waitForFunction(
        (expected) =>
          document.querySelector(".document-name")?.textContent === expected &&
          !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        name,
      );
    await ready("阅读.md");
    const editor = page.locator(".ProseMirror");

    await page.keyboard.press("ControlOrMeta+Shift+e");
    await expect.poll(() => editor.getAttribute("contenteditable")).toBe("false");
    expect(await editor.locator(".comment-inline").isVisible()).toBe(false);

    // 任务仍可勾选并写回源码。
    await editor.locator(".task-checkbox").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "阅读.md"), "utf8"))
      .toBe(source.replace("- [ ] 待办", "- [x] 待办"));

    // 阅读视图里单击链接即跳转。
    await editor.locator('.wiki-link[data-wiki-target="目标"]').click();
    await ready("目标.md");
    await page.keyboard.press("ControlOrMeta+[");
    await ready("阅读.md");
    await expect.poll(() => editor.getAttribute("contenteditable")).toBe("false");

    // 阅读 → 源码 → 阅读：跨源码边界交接文本。
    await page.keyboard.press("ControlOrMeta+e");
    await page.locator(".cm-content").waitFor();
    expect(await page.locator(".cm-content").textContent()).toContain("%%私下的注释%%");
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await expect.poll(() => editor.getAttribute("contenteditable")).toBe("false");
    await expect
      .poll(async () => {
        const session = JSON.parse(await readFile(join(userData, "session.json"), "utf8"));
        return session.reader?.viewModes as Record<string, string> | undefined;
      })
      .toEqual({ "阅读.md": "reading" });
    expect(errors).toEqual([]);

    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.waitForFunction(
      () => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "false",
    );
  } finally {
    await app.close();
  }
});
