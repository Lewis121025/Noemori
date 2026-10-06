/** @vitest-environment jsdom */
import { describe, expect, it, vi, type TestContext } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";
import type { ExportResult } from "@reader/shared/export";
import type { WriteResult } from "@reader/shared/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(t: TestContext) {
  const api = createReaderApiMock({
    exportRun: vi.fn(async (): Promise<ExportResult> => ({
      status: "saved",
      path: "/output/a.pdf",
      warning: null,
      issues: [],
    })),
  });
  const workspace = new ReaderWorkspaceController(api);
  const dispose = workspace.start();
  t.onTestFinished(() => {
    dispose();
    vi.restoreAllMocks();
  });
  await workspace.restore();
  workspace.document.load("a.md", { disk: new TextEncoder().encode("old"), draft: null });
  vi.spyOn(workspace.navigation, "snapshot").mockReturnValue({
    bytes: new TextEncoder().encode("new"),
    revision: 1,
  });
  workspace.requestExport({ kind: "selection", paths: ["a.md"] });
  return { api, workspace };
}

describe("导出的全栏保存与任务门禁", () => {
  it("等待真实写盘完成后才执行，并阻止重复点击启动第二项任务", async (t) => {
    const { api, workspace } = await setup(t);
    const saved = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(saved.promise);
    workspace.markDirty();
    const first = workspace.runExport("pdf", vi.fn(), vi.fn());
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledOnce());
    expect(api.exportRun).not.toHaveBeenCalled();
    expect((await workspace.runExport("pdf", vi.fn(), vi.fn())).status).toBe("failed");
    saved.resolve({ status: "saved", warning: null });
    expect((await first).status).toBe("saved");
    expect(api.exportRun).toHaveBeenCalledOnce();
    expect(api.exportRun).toHaveBeenCalledWith(
      { root: "/notes", format: "pdf", scope: { kind: "selection", paths: ["a.md"] } },
      expect.any(Function),
      expect.any(Function),
    );
    expect(workspace.switching).toBe(false);
  });

  it.for(["conflict", "exception", "composition", "attachment", "serialization"])(
    "前置失败拒绝启动：%s",
    async (failure, t) => {
      const { api, workspace } = await setup(t);
      if (failure === "composition") workspace.setComposing(true);
      else if (failure === "attachment")
        vi.spyOn(workspace.navigation, "settleEditing").mockResolvedValue(false);
      else {
        workspace.markDirty();
        if (failure === "conflict")
          vi.mocked(api.fileWrite).mockResolvedValue({
            status: "conflict",
            disk: new TextEncoder().encode("external"),
          });
        if (failure === "exception")
          vi.mocked(api.fileWrite).mockRejectedValue(new Error("磁盘满"));
        if (failure === "serialization")
          vi.spyOn(workspace.navigation, "snapshot").mockImplementation(() => {
            throw new Error("不能序列化");
          });
      }
      expect((await workspace.runExport("pdf", vi.fn(), vi.fn())).status).toBe("failed");
      expect(api.exportRun).not.toHaveBeenCalled();
      workspace.setComposing(false);
      expect(workspace.switching).toBe(false);
    },
  );

  it("取消保存中的导出仍保留已经成功的前置保存", async (t) => {
    const { api, workspace } = await setup(t);
    const saved = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(saved.promise);
    workspace.markDirty();
    const running = workspace.runExport("pdf", vi.fn(), vi.fn());
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledOnce());
    expect(await workspace.cancelExport()).toBe(true);
    saved.resolve({ status: "saved", warning: null });
    expect(await running).toEqual({ status: "cancelled" });
    expect(api.exportRun).not.toHaveBeenCalled();
    expect(api.exportCancel).not.toHaveBeenCalled();
    expect(workspace.document.dirty).toBe(false);
    expect(new TextDecoder().decode(workspace.document.originalBytes ?? new Uint8Array())).toBe(
      "new",
    );
  });

  it("另一栏保存失败必须阻止活动栏导出，修复后可重新执行", async (t) => {
    const { api, workspace } = await setup(t);
    await workspace.openInOtherPane("b.md");
    const first = workspace.panes[0];
    if (!first) throw new Error("缺少原分栏");
    vi.spyOn(first.navigation, "snapshot").mockImplementation(() => {
      throw new Error("原分栏编辑无法保存");
    });
    first.markDirty();
    expect((await workspace.runExport("pdf", vi.fn(), vi.fn())).status).toBe("failed");
    expect(api.exportRun).not.toHaveBeenCalled();
    vi.spyOn(first.navigation, "snapshot").mockReturnValue({
      bytes: new TextEncoder().encode("fixed"),
      revision: 2,
    });
    expect((await workspace.runExport("pdf", vi.fn(), vi.fn())).status).toBe("saved");
    expect(api.exportRun).toHaveBeenCalledOnce();
  });

  it("原生任务开始后取消只经所属接口，取消失败仍等待实际提交结果", async (t) => {
    const { api, workspace } = await setup(t);
    const native = deferred<ExportResult>();
    vi.mocked(api.exportRun).mockReturnValueOnce(native.promise);
    const running = workspace.runExport("pdf", vi.fn(), vi.fn());
    await vi.waitFor(() => expect(api.exportRun).toHaveBeenCalledOnce());
    expect(await workspace.cancelExport()).toBe(false);
    expect(api.exportCancel).toHaveBeenCalledOnce();
    native.resolve({ status: "saved", path: "/output/a.pdf", warning: "暂存清理失败", issues: [] });
    expect((await running).status).toBe("saved");
    expect(await workspace.cancelExport()).toBe(false);
  });
});
