import { EventEmitter } from "node:events";
import { BrowserWindow, dialog, shell, type WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExportIpc } from "@reader/main/export/ipc";
import { NativeExport } from "@reader/main/export/native";
import { createExportProcessor } from "@reader/main/export/processor";
import { prepareArtifacts } from "@reader/main/export/pipeline";
import { ExportFailure } from "@reader/main/export/errors";
import type { ExportNativePort } from "@reader/main/export/native";
import type { NativeControl } from "../../../../../modules/notes/packages/vault-node";

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: WebContents }, ...args: unknown[]) => unknown>(),
  create: vi.fn(),
}));
vi.mock("@reader/main/export/processor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@reader/main/export/processor")>();
  return { ...actual, createExportProcessor: vi.fn(actual.createExportProcessor) };
});
vi.mock("electron", () => ({
  BrowserWindow: function () {
    return boundary.create();
  },
  ipcMain: {
    handle: (
      name: string,
      callback: (event: { sender: WebContents }, ...args: unknown[]) => unknown,
    ) => {
      boundary.handlers.set(name, callback);
    },
  },
  dialog: { showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));
vi.mock("@reader/main/export/pipeline", async (original) => ({
  ...(await original<typeof import("@reader/main/export/pipeline")>()),
  prepareArtifacts: vi.fn(),
}));
vi.mock("@reader/main/export/render", () => ({
  createExportRenderer: vi.fn(() => ({ render: vi.fn(), pdf: vi.fn() })),
}));

const request = { root: "/vault", format: "pdf", scope: { kind: "selection", paths: ["a.md"] } };
const artifacts = { single: "documents/a.pdf", extension: "pdf", name: "a.pdf", issues: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const state: { cancelled: boolean; committed: boolean; destroyed: boolean; progress: unknown } = {
    cancelled: false,
    committed: false,
    destroyed: false,
    progress: { phase: "checking", completed: 0, total: null },
  };
  const control = {
    cancel: vi.fn(() => {
      if (state.committed) return false;
      state.cancelled = true;
      return true;
    }),
    get cancelled() {
      return state.cancelled;
    },
    get progress() {
      return state.progress;
    },
  };
  const contents = Object.assign(new EventEmitter(), {
    id: 12,
    isDestroyed: vi.fn(() => state.destroyed),
    send: vi.fn(),
  });
  boundary.create.mockReturnValue({ webContents: contents });
  const window = new BrowserWindow({});
  const core: ExportNativePort & { createControl(): NativeControl; recover(): Promise<unknown> } = {
    createControl: () => control,
    recover: vi.fn(async () => []),
    prepare: vi.fn<ExportNativePort["prepare"]>().mockResolvedValue(null),
    action: vi.fn<ExportNativePort["action"]>().mockResolvedValue(null),
  };
  const native = await NativeExport.prepare(
    {
      prepare: async () => ({
        id: "job",
        sourceDirectory: "/stage/source",
        outputDirectory: "/stage/output",
        files: [],
        directories: [],
        bytes: 0,
        resourceBytes: 0,
        resources: 0,
        sealed: false,
      }),
      action: (...args) => core.action(...args),
    },
    { root: "/vault", format: "pdf", scope: { kind: "vault" } },
    "job",
    control,
  );
  vi.spyOn(NativeExport, "prepare").mockResolvedValue(native);
  const target = vi.spyOn(native, "target").mockResolvedValue(false);
  const publish = vi
    .spyOn(native, "publish")
    .mockResolvedValue({ path: "/output/a.pdf", warning: null });
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({
    canceled: false,
    filePath: "/output/a.pdf",
  });
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
  vi.mocked(prepareArtifacts).mockResolvedValue(artifacts);
  registerExportIpc(() => window, core);
  const call = async (name: string, ...args: unknown[]) => {
    const handler = boundary.handlers.get(`reader.export.${name}`);
    if (!handler) throw new Error("IPC 未登记");
    return handler({ sender: window.webContents }, ...args);
  };
  return { state, control, contents, window, core, native, target, publish, call };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  boundary.handlers.clear();
});

describe("EXP-IPC 导出协调器的归属、取消与提交诊断", () => {
  it.for(["saved", "cancelled", "failed"])(
    "解析线程清理失败仍继续释放文件暂存并保留真实结果：%s",
    async (status) => {
      const { call, core } = await fixture();
      vi.mocked(createExportProcessor).mockReturnValueOnce({
        compute: async () => {
          throw new Error("不应计算");
        },
        parse: async () => {
          throw new Error("不应解析");
        },
        close: async () => {
          throw new Error("worker shutdown fault");
        },
      });
      if (status === "cancelled")
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: "" });
      if (status === "failed")
        vi.mocked(prepareArtifacts).mockRejectedValue(new Error("conversion fault"));
      const result = await call("run", request, "job");
      if (status === "saved")
        expect(result).toMatchObject({
          status: "saved",
          warning: expect.stringContaining("worker shutdown fault"),
        });
      else
        expect(result).toMatchObject({
          status: "failed",
          issues: expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining("worker shutdown fault") }),
          ]),
        });
      expect(core.action).toHaveBeenCalledWith("job", { action: "discard" });
    },
  );
  it("成功结果被交付后才允许确认凭据，其他任务或重复确认被拒绝", async () => {
    const { call, core } = await fixture();
    await expect(call("acknowledge", "job")).rejects.toThrow("交付确认");
    expect(await call("run", request, "job")).toMatchObject({ status: "saved" });
    await expect(call("acknowledge", "another")).rejects.toThrow("交付确认");
    await expect(call("acknowledge", "job")).resolves.toBeUndefined();
    expect(core.action).toHaveBeenLastCalledWith("job", { action: "acknowledge" });
    await expect(call("acknowledge", "job")).rejects.toThrow("交付确认");
  });

  it("启动时只核实结果，用户看到报告后才确认；单个结果可显示文件", async () => {
    const { call, core } = await fixture();
    await expect(call("recover")).resolves.toBeUndefined();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    vi.mocked(core.recover).mockResolvedValue([
      { id: "previous", path: "/output/a.pdf", status: "saved" },
    ]);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    await expect(call("recover")).resolves.toBeUndefined();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "info",
        detail: "已生成：/output/a.pdf",
        buttons: ["知道了", "显示文件"],
      }),
    );
    expect(shell.showItemInFolder).toHaveBeenCalledWith("/output/a.pdf");
    expect(core.action).toHaveBeenCalledWith("previous", { action: "acknowledge" });
  });

  it("无法确认的目标不会被误报未生成，关窗时保留恢复凭据", async () => {
    const { call, core, state } = await fixture();
    vi.mocked(core.recover).mockResolvedValue([
      { id: "one", path: "/output/a.pdf", status: "saved" },
      { id: "two", path: "/output/b.pdf", status: "unconfirmed" },
    ]);
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(async () => {
      state.destroyed = true;
      return { response: 0, checkboxChecked: false };
    });
    await expect(call("recover")).resolves.toBeUndefined();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "warning",
        detail: expect.stringContaining("结果尚不能确认"),
      }),
    );
    expect(core.action).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [{}],
    [{ id: "bad/id", path: "/output/a.pdf", status: "saved" }],
    [{ id: "one", path: "relative", status: "saved" }],
    [{ id: "one", path: "/a", status: "unknown" }],
    [
      { id: "one", path: "/a", status: "saved" },
      { id: "one", path: "/b", status: "saved" },
    ],
  ])("损坏恢复响应不得触发确认或文件操作：%j", async (value) => {
    const { call, core } = await fixture();
    vi.mocked(core.recover).mockResolvedValue(value);
    await expect(call("recover")).rejects.toThrow();
    expect(core.action).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
  it("窗口关闭、迟到进度及转换失败同时发生时，不向旧窗口发送或发布", async () => {
    const { call, state, contents, publish } = await fixture();
    vi.mocked(prepareArtifacts).mockImplementation(
      async (_native, _request, _renderer, signal, report) => {
        state.destroyed = true;
        contents.emit("destroyed");
        contents.send.mockClear();
        report.plan({ files: ["a.md"], bytes: 1, issues: [] });
        report.progress(1, 1, "a.md");
        expect(signal.aborted).toBe(true);
        throw new Error("late conversion failure");
      },
    );
    expect(await call("run", request, "job")).toEqual({ status: "cancelled" });
    expect(contents.send).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await call("cancel", "job")).toBe(false);
  });
  it("生成、预检和进度均绑定任务，完成后可定位已提交的产物", async () => {
    const { call, contents, target, publish, core } = await fixture();
    vi.mocked(prepareArtifacts).mockImplementation(
      async (_native, _request, _renderer, _signal, report) => {
        report.progress(1, 1, "a.md");
        report.plan({ files: ["a.md"], bytes: 10, issues: [] });
        return artifacts;
      },
    );
    await expect(call("run", request, "job")).resolves.toEqual({
      status: "saved",
      path: "/output/a.pdf",
      issues: [],
      warning: null,
    });
    expect(contents.send).toHaveBeenCalledWith("reader.export.plan", "job", {
      files: ["a.md"],
      bytes: 10,
      issues: [],
    });
    expect(contents.send).toHaveBeenCalledWith(
      "reader.export.progress",
      "job",
      expect.objectContaining({ phase: "converting", completed: 1 }),
    );
    expect(target).toHaveBeenCalledWith("/output/a.pdf");
    expect(publish).toHaveBeenCalledOnce();
    expect(core.action).toHaveBeenCalledWith("job", { action: "discard" });
    await call("reveal");
    expect(shell.showItemInFolder).toHaveBeenCalledWith("/output/a.pdf");
    expect(await call("cancel", "job")).toBe(false);
  });

  it("重复启动与其他任务编号不能影响正在运行的任务", async () => {
    const { call, publish } = await fixture();
    const converting = deferred<typeof artifacts>();
    vi.mocked(prepareArtifacts).mockReturnValue(converting.promise);
    const running = call("run", request, "job");
    await vi.waitFor(() => expect(prepareArtifacts).toHaveBeenCalledOnce());
    await expect(call("run", request, "other")).rejects.toThrow("已有导出任务");
    expect(await call("cancel", "other")).toBe(false);
    expect(await call("cancel", "job")).toBe(true);
    converting.resolve(artifacts);
    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(publish).not.toHaveBeenCalled();
  });

  it.for(["dialog", "overwrite", "window", "native"])("提交前停止不会发布：%s", async (reason) => {
    const { call, target, contents, state, publish } = await fixture();
    if (reason === "dialog")
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: "" });
    if (reason === "overwrite") {
      target.mockResolvedValue(true);
      vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    }
    if (reason === "window" || reason === "native")
      vi.mocked(prepareArtifacts).mockImplementation(async () => {
        if (reason === "window") {
          state.destroyed = true;
          contents.emit("destroyed");
        } else {
          state.cancelled = true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return artifacts;
      });
    await expect(call("run", request, "job")).resolves.toEqual({ status: "cancelled" });
    expect(publish).not.toHaveBeenCalled();
    expect(contents.listenerCount("destroyed")).toBe(0);
  });

  it("越过提交边界后取消失败，仍交付真实成功结果", async () => {
    const { call, state, publish } = await fixture();
    const committed = deferred<{ path: string; warning: string | null }>();
    publish.mockImplementation(() => {
      state.committed = true;
      return committed.promise;
    });
    const running = call("run", request, "job");
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(await call("cancel", "job")).toBe(false);
    committed.resolve({ path: "/output/a.pdf", warning: "目录同步失败" });
    await expect(running).resolves.toMatchObject({ status: "saved", warning: "目录同步失败" });
  });

  it.for(["prepare", "convert", "target", "publish", "progress"])(
    "失败保留原因并释放任务，以便修复后重试：%s",
    async (phase) => {
      const { call, target, publish, state } = await fixture();
      if (phase === "prepare")
        vi.mocked(NativeExport.prepare).mockRejectedValueOnce(new Error("snapshot fault"));
      if (phase === "convert")
        vi.mocked(prepareArtifacts).mockRejectedValueOnce(
          new ExportFailure([
            { path: "a.md", line: 3, severity: "error", message: "formula fault" },
          ]),
        );
      if (phase === "target") target.mockRejectedValueOnce(new Error("target fault"));
      if (phase === "publish") publish.mockRejectedValueOnce(new Error("commit fault"));
      if (phase === "progress") state.progress = null;
      await expect(call("run", request, "job")).resolves.toMatchObject({
        status: "failed",
        issues: [expect.objectContaining({ severity: "error" })],
      });
      state.progress = { phase: "checking", completed: 0, total: null };
      state.cancelled = false;
      await expect(call("run", request, "job")).resolves.toMatchObject({ status: "saved" });
    },
  );

  it.for(["saved", "cancelled", "failed"])(
    "清理失败的结果必须反映真实提交状态：%s",
    async (status) => {
      const { call, core, contents } = await fixture();
      vi.mocked(core.action).mockRejectedValueOnce(new Error("cleanup fault"));
      if (status === "cancelled")
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: "" });
      if (status === "failed")
        vi.mocked(prepareArtifacts).mockRejectedValue(new Error("conversion fault"));
      if (status === "saved")
        contents.send.mockImplementation(() => {
          throw new Error("notification fault");
        });
      const result = await call("run", request, "job");
      if (status === "saved")
        expect(result).toMatchObject({
          status: "saved",
          warning: expect.stringContaining("cleanup fault"),
        });
      else
        expect(result).toMatchObject({
          status: "failed",
          issues: expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining("cleanup fault") }),
          ]),
        });
    },
  );

  it("失效窗口、非法输入、缺少结果均不获得任何文件能力", async () => {
    const { call, window, core, contents } = await fixture();
    await expect(call("reveal")).rejects.toThrow();
    await expect(call("run", null, "job")).rejects.toThrow();
    await expect(call("run", request, "../job")).rejects.toThrow();
    registerExportIpc(() => null, core);
    await expect(call("run", request, "job")).rejects.toThrow("当前窗口");
    boundary.create.mockReturnValue({ webContents: { id: 99 } });
    registerExportIpc(() => new BrowserWindow({}), core);
    await expect(call("run", request, "job")).rejects.toThrow("当前窗口");
    registerExportIpc(() => window, core);
    await call("run", request, "job");
    contents.emit("destroyed");
    await expect(call("reveal")).rejects.toThrow();
  });
});
