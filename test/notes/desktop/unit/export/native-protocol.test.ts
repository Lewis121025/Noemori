import { describe, expect, it, vi } from "vitest";
import {
  NativeExport,
  parseExportSnapshot,
  type ExportNativePort,
} from "@reader/main/export/native";
import { EXPORT_LIMITS } from "@reader/shared/export";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const snapshot = () => ({
  id: "task-1",
  sourceDirectory: "/stage/source",
  outputDirectory: "/stage/output",
  files: [{ path: "a.md", bytes: 1, hash: "a".repeat(64) }],
  directories: ["empty"],
  bytes: 1,
  resourceBytes: 0,
  resources: 0,
  sealed: false,
});

describe("原生导出快照协议", () => {
  it("正文与已登记产物超过网络图片上限仍可逐块核验读取", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-export-read-budget-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const sourceDirectory = join(directory, "source");
    const outputDirectory = join(directory, "output");
    await mkdir(sourceDirectory);
    await mkdir(outputDirectory);
    const bytes = new Uint8Array(EXPORT_LIMITS.resourceBytes + 1).fill(42);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(sourceDirectory, "a.md"), bytes);
    const native = await NativeExport.prepare(
      {
        prepare: async () => ({
          ...snapshot(),
          sourceDirectory,
          outputDirectory,
          files: [{ path: "a.md", hash, bytes: bytes.byteLength }],
          bytes: bytes.byteLength,
        }),
        action: async (_id, action, data) => {
          if (action.action === "write" && data)
            await writeFile(join(outputDirectory, action.path), data);
          return null;
        },
      },
      { root: "/vault", format: "pdf", scope: { kind: "vault" } },
      "task-1",
      { cancel: () => false, cancelled: false, progress: {} },
    );
    expect(
      createHash("sha256")
        .update(await native.read("a.md"))
        .digest("hex"),
    ).toBe(hash);
    await native.write("large.pdf", bytes);
    expect(
      createHash("sha256")
        .update(await native.readOutput("large.pdf"))
        .digest("hex"),
    ).toBe(hash);
  });
  it("确认未提交后传播原始 IO 失败；不能把查询本身误当成发布", async () => {
    const failure = new Error("disk full");
    const action = vi
      .fn<ExportNativePort["action"]>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(null);
    const native = await NativeExport.prepare(
      { prepare: async () => snapshot(), action },
      { root: "/vault", format: "pdf", scope: { kind: "vault" } },
      "task-1",
      { cancel: () => false, cancelled: false, progress: {} },
    );
    await expect(native.publish("a.pdf")).rejects.toBe(failure);
    await native.dispose();
    expect(action).toHaveBeenLastCalledWith("task-1", { action: "discard" });
  });
  it.each(["malformed", "lost"])(
    "提交后的%s回复必须核实实际结果，不能再次发布或误报失败",
    async (mode) => {
      const calls: string[] = [];
      const port: ExportNativePort = {
        prepare: async () => snapshot(),
        action: async (_id, action) => {
          calls.push(action.action);
          if (action.action === "publish") {
            if (mode === "lost") throw new Error("reply lost");
            return { path: null };
          }
          return { path: "/output/a.pdf", warning: null };
        },
      };
      const native = await NativeExport.prepare(
        port,
        { root: "/vault", format: "pdf", scope: { kind: "vault" } },
        "task-1",
        { cancel: () => false, cancelled: false, progress: {} },
      );
      const result = await native.publish("a.pdf");
      expect(result.path).toBe("/output/a.pdf");
      expect(result.warning).toContain("核实");
      expect(calls).toEqual(["publish", "outcome"]);
    },
  );

  it("无法核实提交时保留恢复凭据，明确未提交才允许正常清理", async () => {
    const action = vi
      .fn<ExportNativePort["action"]>()
      .mockRejectedValueOnce(new Error("lost"))
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValue(null);
    const native = await NativeExport.prepare(
      { prepare: async () => snapshot(), action },
      { root: "/vault", format: "pdf", scope: { kind: "vault" } },
      "task-1",
      { cancel: () => false, cancelled: false, progress: {} },
    );
    await expect(native.publish("a.pdf")).rejects.toThrow("无法核实");
    await native.dispose();
    expect(action).toHaveBeenLastCalledWith("task-1", { action: "preserve" });
  });
  it("验证任务、路径、哈希、源预算和下载预算的完整一致性", () => {
    expect(parseExportSnapshot(snapshot()).files[0]?.path).toBe("a.md");
    for (const patch of [
      { id: "../task" },
      { sourceDirectory: "relative" },
      { outputDirectory: "relative" },
      { directories: ["../outside"] },
      { files: [{ path: "../outside", bytes: 1, hash: "a".repeat(64) }] },
      { files: [{ path: "a.md", bytes: 1, hash: "bad" }] },
      { bytes: 2 },
      { bytes: -1 },
      { resources: EXPORT_LIMITS.files },
      { resourceBytes: EXPORT_LIMITS.bytes },
      { resources: 0.5 },
      { resourceBytes: -1 },
      { sealed: "yes" },
    ])
      expect(() => parseExportSnapshot({ ...snapshot(), ...patch })).toThrow();
    expect(() =>
      parseExportSnapshot({
        ...snapshot(),
        resources: EXPORT_LIMITS.files - 1,
        resourceBytes: EXPORT_LIMITS.bytes - 1,
      }),
    ).not.toThrow();
    expect(() =>
      parseExportSnapshot({
        ...snapshot(),
        files: [...snapshot().files, ...snapshot().files],
        bytes: 2,
      }),
    ).toThrow();
  });
});
