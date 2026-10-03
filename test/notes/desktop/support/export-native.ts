import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "vitest";
import { CoreClient } from "../../../../modules/notes/packages/desktop/src/main/core-client";
import { parseExportSource } from "../../../../modules/notes/packages/desktop/src/features/reader/main/export/source-parser";
import { NativeExport } from "../../../../modules/notes/packages/desktop/src/features/reader/main/export/native";
import type {
  ExportFormat,
  ExportRequest,
} from "../../../../modules/notes/packages/desktop/src/features/reader/shared/export";

/** 使用实际 Rust 文件快照，测试转换边界时不模拟路径、草稿和资源计数语义。 */
export async function nativeExportFixture(
  t: TestContext,
  files: Readonly<Record<string, string | Uint8Array>>,
  format: ExportFormat,
  paths: string[] | null = ["a.md"],
  directories: readonly string[] = [],
) {
  const directory = await mkdtemp(join(tmpdir(), "noemori-export-pipeline-"));
  const root = join(directory, "vault");
  await mkdir(root);
  for (const path of directories) await mkdir(join(root, path), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const core = new CoreClient(join(directory, "state"), () => {});
  let native: NativeExport | undefined;
  t.onTestFinished(async () => {
    try {
      await native?.dispose();
    } finally {
      try {
        await core.shutdown();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  await core.call("vaultOpen", root);
  const request: ExportRequest = {
    root,
    format,
    scope: paths === null ? { kind: "vault" } : { kind: "selection", paths },
  };
  native = await NativeExport.prepare(
    {
      prepare: (...args) => core.call("exportPrepare", ...args),
      action: (...args) => core.call("exportAction", ...args),
    },
    request,
    "pipeline",
    core.createControl(),
  );
  return {
    directory,
    root,
    core,
    native,
    request,
    parse: async (bytes: Uint8Array) => parseExportSource(bytes),
  };
}
