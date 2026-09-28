import { openLibrary } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { CoreClient } from "../../../modules/notes/packages/desktop/src/main/core-client";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("目录被外部替换后，恢复草稿仍可打开、继续编辑并安全另存", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-recovery-e2e-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(join(vault, "归档"), { recursive: true }), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "欢迎.md"), "# 欢迎\n"),
    writeFile(join(vault, "归档/笔记.md"), "外部版本"),
    writeFile(join(vault, "旧笔记.md"), "外部版本"),
  ]);
  const core = new CoreClient(
    new Worker(new URL("out/main/core-worker.js", desktop), { workerData: userData }),
    () => {},
  );
  try {
    await core.call("vaultOpen", vault);
    for (const path of ["归档/笔记.md", "旧笔记.md"])
      await core.call(
        "fileWrite",
        path,
        new TextEncoder().encode("# 恢复的想法\n\n这些编辑需要保留。\n"),
        new TextEncoder().encode("原始版本"),
      );
    await core.call("readerSessionPatch", {
      documents: {
        panes: [{ currentPath: "欢迎.md", history: { back: [], forward: [] } }],
        active: 0,
        split: false,
      },
    });
  } finally {
    await core.shutdown();
  }
  await rm(join(vault, "归档"), { recursive: true });
  await writeFile(join(vault, "归档"), "真实文件，不能覆盖");
  await rm(join(vault, "旧笔记.md"));
  await mkdir(join(vault, "旧笔记.md"));
  await writeFile(join(vault, "旧笔记.md/child.md"), "真实目录中的内容");
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
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
    await page.getByRole("heading", { name: "欢迎", exact: true }).waitFor();
    await openLibrary(page);
    const recovery = page.getByRole("region", { name: "待恢复的笔记" });
    expect(await recovery.getByRole("button").count()).toBe(2);
    const files = page.getByRole("navigation", { name: "文件列表" });
    await files.getByRole("treeitem", { name: "旧笔记.md", exact: true }).click();
    expect(await files.getByRole("treeitem", { name: "child.md", exact: true }).isVisible()).toBe(
      true,
    );
    await recovery.locator('[data-path="归档/笔记.md"]').click();
    await page.getByRole("heading", { name: "恢复的想法", exact: true }).waitFor();
    await page.getByRole("button", { name: "处理保存问题", exact: true }).click();
    const notice = page.getByRole("region", { name: "保存需要处理" });
    expect(await notice.innerText()).toContain("原文件暂时无法读取");
    expect(await notice.locator(".save-error").isVisible()).toBe(false);
    await notice.getByText("查看详细原因", { exact: true }).click();
    expect(await notice.locator(".save-error").isVisible()).toBe(true);
    await notice.getByText("查看详细原因", { exact: true }).click();
    const screenshots = process.env.NOUS_RECOVERY_SCREENSHOTS;
    await page.getByRole("button", { name: "切换笔记库" }).click();
    await page.getByRole("button", { name: "浅色", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "处理保存问题", exact: true }).click();
    if (screenshots) await page.screenshot({ path: join(screenshots, "nous-recovery-light.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "切换笔记库" }).click();
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "处理保存问题", exact: true }).click();
    if (screenshots) await page.screenshot({ path: join(screenshots, "nous-recovery-dark.png") });
    await page.keyboard.press("Escape");
    await page.locator(".ProseMirror p").click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("继续写下新内容。");
    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForFunction(
      () =>
        document.querySelector(".save-status")?.textContent === "存在保存冲突" &&
        document.querySelector(".save-error")?.textContent?.includes("父路径不是目录"),
    );
    await page.getByRole("button", { name: "处理保存问题", exact: true }).click();
    await notice.getByRole("button", { name: "另存为副本", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector(".document-name")?.textContent === "笔记 (副本).md",
    );
    expect(await readFile(join(vault, "笔记 (副本).md"), "utf8")).toContain("继续写下新内容");
    await openLibrary(page);
    expect(await recovery.getByRole("button").count()).toBe(1);
    await recovery.locator('[data-path="旧笔记.md"]').click();
    await page.getByRole("button", { name: "处理保存问题", exact: true }).click();
    await notice.waitFor();
    await notice.getByRole("button", { name: "另存为副本", exact: true }).click();
    await expect.poll(() => page.locator(".document-name").textContent()).toBe("旧笔记 (副本).md");
    expect(await readFile(join(vault, "旧笔记 (副本).md"), "utf8")).toContain("这些编辑需要保留");
    expect(await readFile(join(vault, "归档"), "utf8")).toBe("真实文件，不能覆盖");
    expect(await readFile(join(vault, "旧笔记.md/child.md"), "utf8")).toBe("真实目录中的内容");
    expect(errors).toEqual([]);
  } finally {
    // 保存失败会阻止正常关窗；测试结束只终止本用例创建的进程，避免失败时遗留窗口。
    const child = app.process();
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  }
});
