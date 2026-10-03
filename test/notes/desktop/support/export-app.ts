import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import type { TestContext } from "vitest";
import type {
  ExportFormat,
  ExportRequest,
} from "../../../../modules/notes/packages/desktop/src/features/reader/shared/export";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

/** 千页标准正文同时用于内容完整性和重负载取消验收，唯一标记可独立核对阅读顺序。 */
export function thousandPageExportSource() {
  const paragraphs = Array.from({ length: 24000 }, (_, index) => `P${String(index).padStart(5, "0")} ${"A complete paragraph with searchable words and preserved reading order. ".repeat(2)}`);
  return { paragraphs, source: "# Thousand page acceptance\n\n" + paragraphs.join("\n\n") + "\n" };
}

/** 生产构建的独立导出测试库；只保留最小编辑文档，排除编辑器加载大样本的干扰。 */
export async function launchExportApp(t: TestContext, files: Readonly<Record<string, string>>) {
  const directory = await mkdtemp(join(tmpdir(), "noemori-export-acceptance-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const vault = join(directory, "vault");
  const state = join(directory, "state");
  const output = join(directory, "output");
  await Promise.all([mkdir(vault), mkdir(state), mkdir(output)]);
  await writeFile(join(vault, "Home.md"), "# 保持界面可操作\n");
  for (const [path, source] of Object.entries(files)) await writeFile(join(vault, path), source);
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      reader: { vaultRoot: vault, currentPath: "Home.md", filesCollapsed: true },
      appearance: "light",
      window: null,
    }),
  );
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (item): item is [string, string] =>
        item[1] !== undefined && item[0] !== "ELECTRON_RENDERER_URL",
    ),
  );
  // 应用本身看不到系统 Pandoc；独立验证工具仍在测试进程中按绝对路径运行。
  env["PATH"] = "/usr/bin:/bin";
  const app = await electron.launch({
    executablePath: executable,
    env,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${state}`,
      "--no-sandbox",
      "--js-flags=--expose-gc",
    ],
  });
  t.onTestFinished(() => app.close());
  const page = await app.firstWindow();
  await page.locator(".document-name").filter({ hasText: "Home.md" }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
  );
  await page.context().setOffline(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const request = (format: ExportFormat, paths: string[]): ExportRequest => ({
    root: vault,
    format,
    scope: { kind: "selection", paths },
  });
  const destination = async (filename: string): Promise<string> => {
    const path = join(output, filename);
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, path);
    return path;
  };
  return { app, page, directory, vault, state, output, errors, request, destination };
}
