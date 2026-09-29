/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { VaultEntry } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let api: ReturnType<typeof createReaderApiMock>;
let workspace: ReaderWorkspaceController;

beforeEach(async () => {
  api = createReaderApiMock({
    vaultEntries: vi.fn(async (): Promise<VaultEntry[]> => [
      { path: "a.md", kind: "file" },
      { path: "b.md", kind: "file" },
      { path: "renamed.md", kind: "file" },
    ]),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  await workspace.openFile("a.md");
});

afterEach(() => {
  workspace.fileTree.reset();
  for (const pane of workspace.panes) pane.dispose();
  vi.restoreAllMocks();
});

describe("会话写入失败与已完成操作的边界", () => {
  it("连续滚动合并最新位置，关闭立即提交尚未到期的位置", async () => {
    vi.useFakeTimers();
    const stop = workspace.start();
    let offset = 0;
    vi.spyOn(workspace.navigation, "capturePosition").mockImplementation(() => ({
      reading: { source: { offset, before: "", after: "" }, inset: 0 },
      selection: null,
    }));
    vi.mocked(api.sessionSetDocuments).mockClear();
    try {
      for (offset = 1; offset <= 20; offset++) workspace.activePane.rememberReadingPosition();
      await Promise.resolve();
      expect(api.sessionSetDocuments).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(api.sessionSetDocuments).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(api.sessionSetDocuments).mock.calls[0]?.[0].panes[0]?.position?.source.offset,
      ).toBe(21);
      offset = 99;
      workspace.activePane.rememberReadingPosition();
      expect(await workspace.flushBeforeClose()).toBe(true);
      expect(
        vi.mocked(api.sessionSetDocuments).mock.calls.at(-1)?.[0].panes[0]?.position?.source.offset,
      ).toBe(99);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.sessionSetDocuments).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("切库前提交旧库最后位置，切库后不再发送旧阅读快照", async () => {
    vi.useFakeTimers();
    const stop = workspace.start();
    const writes: string[] = [];
    vi.mocked(api.sessionSetDocuments).mockImplementation(async (state) => {
      writes.push(state.panes[0]?.currentPath ?? "empty");
    });
    vi.mocked(api.vaultOpen).mockImplementation(async () => {
      writes.push("open");
      return { root: "/other", entries: [] };
    });
    try {
      workspace.activePane.rememberReadingPosition();
      await workspace.openVault();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toEqual(["a.md", "open"]);
      expect(workspace.vaultRoot).toBe("/other");
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("视图记忆失败保留当前视图，错误不会被后续打开和正文保存清除", async () => {
    vi.mocked(api.sessionSetViewModes).mockRejectedValueOnce(new Error("视图记忆不可写"));
    await workspace.toggleReadingMode();
    expect(workspace.viewMode).toBe("reading");
    expect(workspace.message).toContain("视图记忆未能保存");
    expect(workspace.messageDetail).toBe("视图记忆不可写");

    await workspace.openFile("b.md");
    vi.spyOn(workspace.navigation, "snapshot").mockReturnValue({
      bytes: new TextEncoder().encode("修改后的正文\n"),
      revision: 1,
    });
    workspace.document.markDirty();
    await workspace.activePane.persist();
    expect(api.fileWrite).toHaveBeenCalled();
    expect(workspace.document.dirty).toBe(false);
    expect(workspace.message).toContain("视图记忆未能保存");
    expect(workspace.messageNeedsAttention).toBe(true);
    workspace.dismissMessage();
    expect(workspace.message).toBe("");
  });

  it("确认优先展示的操作错误后，仍能查看尚未确认的会话故障", async () => {
    vi.mocked(api.sessionSetViewModes).mockRejectedValueOnce(new Error("视图记忆不可写"));
    await workspace.toggleReadingMode();
    workspace.report("文件操作失败", new Error("目标已存在"));
    expect(workspace.message).toBe("文件操作失败");
    expect(workspace.messageDetail).toBe("目标已存在");
    workspace.dismissMessage();
    expect(workspace.message).toContain("视图记忆未能保存");
    expect(workspace.messageDetail).toBe("视图记忆不可写");
    workspace.dismissMessage();
    expect(workspace.message).toBe("");
  });

  it("最近打开写入失败仍完成打开与历史更新，并保留可见原因", async () => {
    vi.mocked(api.sessionSetRecentFiles).mockRejectedValueOnce(new Error("最近列表不可写"));
    await workspace.openFile("b.md");
    expect(workspace.document.path).toBe("b.md");
    expect(workspace.recentFiles).toEqual(["b.md", "a.md"]);
    expect(workspace.history.snapshot().back).toEqual([{ path: "a.md", anchor: null }]);
    expect(workspace.message).toContain("最近打开列表未能保存");
    expect(workspace.messageDetail).toBe("最近列表不可写");
  });

  it("会话失败不打断已加载文件的历史提交与引用刷新，重试可保存完整现场", async () => {
    vi.mocked(api.sessionSetDocuments).mockClear().mockRejectedValueOnce(new Error("会话不可写"));
    await workspace.openFile("b.md");
    expect(workspace.document.path).toBe("b.md");
    expect(workspace.activePane.currentStep).toEqual({ path: "b.md", anchor: null });
    expect(workspace.history.snapshot().back).toEqual([{ path: "a.md", anchor: null }]);
    expect(api.indexMentionsTo).toHaveBeenLastCalledWith("b.md");
    expect(workspace.message).toContain("阅读现场未能保存");
    expect(workspace.messageDetail).toBe("会话不可写");
    expect(workspace.switching).toBe(false);
    expect(await workspace.flushBeforeClose()).toBe(true);
    expect(api.sessionSetDocuments).toHaveBeenLastCalledWith({
      panes: [
        { currentPath: "b.md", history: { back: [{ path: "a.md", anchor: null }], forward: [] } },
      ],
      active: 0,
      split: false,
    });
  });

  it("打开文件只持久化已提交的完整阅读历史", async () => {
    vi.mocked(api.sessionSetDocuments).mockClear();
    await workspace.openFile("b.md");
    const snapshots = vi.mocked(api.sessionSetDocuments).mock.calls.map(([state]) => state);
    expect(snapshots.length).toBeGreaterThan(0);
    for (const state of snapshots) {
      expect(state.panes[0]).toEqual({
        currentPath: "b.md",
        history: { back: [{ path: "a.md", anchor: null }], forward: [] },
      });
    }
  });

  it.each(["back", "forward"] as const)("%s 的会话失败不留下半更新的历史", async (direction) => {
    await workspace.openFile("b.md");
    if (direction === "forward") await workspace.activePane.navigateBack();
    vi.mocked(api.sessionSetDocuments).mockRejectedValueOnce(new Error("导航现场不可写"));
    if (direction === "back") await workspace.activePane.navigateBack();
    else await workspace.activePane.navigateForward();
    const target = direction === "back" ? "a.md" : "b.md";
    expect(workspace.document.path).toBe(target);
    expect(workspace.activePane.currentStep?.path).toBe(target);
    expect(workspace.history.snapshot()).toEqual(
      direction === "back"
        ? { back: [], forward: [{ path: "b.md", anchor: null }] }
        : { back: [{ path: "a.md", anchor: null }], forward: [] },
    );
    expect(workspace.message).toContain("阅读现场未能保存");
    expect(workspace.messageDetail).toBe("导航现场不可写");
  });

  it("同文档锚点跳转的会话失败可见，后退栈仍可使用", async () => {
    vi.spyOn(workspace.navigation, "jumpToHeadingText").mockReturnValue(true);
    vi.mocked(api.sessionSetDocuments).mockRejectedValueOnce(new Error("锚点现场不可写"));
    await workspace.activePane.openResolved("a.md", "标题");
    await vi.waitFor(() => expect(workspace.message).toContain("阅读现场未能保存"));
    expect(workspace.activePane.currentStep).toEqual({ path: "a.md", anchor: "标题" });
    expect(workspace.history.snapshot().back).toEqual([{ path: "a.md", anchor: null }]);
    expect(workspace.messageDetail).toBe("锚点现场不可写");
  });

  it.each(["sessionSetViewModes", "sessionSetRecentFiles"] as const)(
    "改名成功提示不能清除 %s 的失败",
    async (method) => {
      vi.mocked(api[method]).mockRejectedValue(new Error("路径记忆不可写"));
      expect(await workspace.renameEntry("a.md", "renamed.md")).toBeNull();
      expect(workspace.document.path).toBe("renamed.md");
      expect(workspace.message).toContain("未能保存");
      expect(workspace.messageDetail).toBe("路径记忆不可写");
    },
  );

  it("关闭时仍要求现场真正写入成功，失败可重试", async () => {
    vi.mocked(api.sessionSetDocuments).mockRejectedValueOnce(new Error("会话不可写"));
    expect(await workspace.flushBeforeClose()).toBe(false);
    expect(workspace.message).toContain("请重试关闭");
    expect(workspace.document.path).toBe("a.md");
    expect(await workspace.flushBeforeClose()).toBe(true);
  });

  it.each(["rename", "batch"] as const)(
    "%s 已提交后会话失败不能清空已迁移的文档",
    async (operation) => {
      vi.mocked(api.sessionSetDocuments).mockRejectedValue(new Error("迁移现场不可写"));
      if (operation === "rename") {
        expect(await workspace.renameEntry("a.md", "renamed.md")).toBeNull();
      } else {
        vi.mocked(api.entryBatch).mockResolvedValueOnce({
          completed: [{ from: "a.md", to: "renamed.md" }],
          remaining: [],
          skipped: [],
          issues: [],
          warning: null,
        });
        const result = await workspace.batchEntries({
          root: "/notes",
          action: "move",
          paths: ["a.md"],
          destination: "",
        });
        expect(result.completed).toEqual([{ from: "a.md", to: "renamed.md" }]);
        expect(result.remaining).toEqual([]);
      }
      expect(workspace.document.path).toBe("renamed.md");
      expect(workspace.activePane.currentStep?.path).toBe("renamed.md");
      expect(workspace.message).toContain("阅读现场未能保存");
      expect(workspace.messageDetail).toBe("迁移现场不可写");
    },
  );

  it.each(["/other", "/notes"])(
    "打开 %s 后不再显示上次开库期间延迟返回的会话错误",
    async (root) => {
      let reject!: (error: Error) => void;
      const writing = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      vi.mocked(api.sessionSetViewModes).mockReturnValueOnce(writing);
      await workspace.toggleReadingMode();
      vi.mocked(api.vaultOpen).mockResolvedValueOnce({ root, entries: [] });
      await workspace.openVault();
      reject(new Error("旧库不可写"));
      await expect(writing).rejects.toThrow("旧库不可写");
      expect(workspace.vaultRoot).toBe(root);
      expect(workspace.message).toBe("");
    },
  );
});
