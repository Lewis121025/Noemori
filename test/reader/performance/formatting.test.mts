import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

import { longDocumentScene } from "../fixtures/quality-scenes";
import { checkBudget } from "./budget";

const desktop = new URL("../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("1200 段长文输入到可见更新的桌面响应预算", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-formatting-bench-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const paragraphs = 1200;
  await Promise.all([
    writeFile(join(vault, "长文.md"), longDocumentScene),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({ vaultRoot: vault, currentPath: "长文.md" }),
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
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    expect(await editor.locator(":scope > p").count()).toBe(paragraphs);
    await editor.focus();
    const latency = await page.evaluateHandle(() => {
      const samples: number[] = [];
      const record = (event: InputEvent): void => {
        if (event.inputType !== "insertText") return;
        const start = performance.now();
        requestAnimationFrame(() => setTimeout(() => samples.push(performance.now() - start), 0));
      };
      document.addEventListener("beforeinput", record, { capture: true });
      return samples;
    });
    await page.keyboard.press("ControlOrMeta+Home");
    for (let index = 0; index < 35; index++) {
      await page.keyboard.insertText("续");
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
      );
    }
    const samples = await latency.jsonValue();
    expect(await editor.locator(":scope > p").first().innerText()).toContain("续".repeat(35));
    await checkBudget("long-document-input", samples.slice(5), 32);
    await latency.dispose();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
