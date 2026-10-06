import { beforeEach, expect, it, vi } from "vitest";
import { ipcRenderer } from "electron";
import { createReaderApi } from "@reader/preload/api";
import { ReaderDocument } from "@reader/renderer/document/state.svelte";

vi.mock("electron", () => ({
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

const bytes = (text: string) => new TextEncoder().encode(text);
const emptyQuery = () => ({ expr: { kind: "and" as const, children: [] }, limit: 100 });
beforeEach(() => vi.clearAllMocks());

it("无效保存响应不能清除编辑、更新磁盘基准或冒充保存成功", async () => {
  const document = new ReaderDocument(createReaderApi());
  document.load("note.md", { disk: bytes("原文"), draft: null });
  document.markDirty();
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ status: "failed", warning: null });
  expect(await document.save(() => ({ bytes: bytes("最新编辑"), revision: 1 }))).toBeNull();
  expect(document.dirty).toBe(true);
  expect(document.originalBytes).toEqual(bytes("原文"));
  expect(document.saveError).toContain("无法确认保存结果");
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ status: "saved", warning: null });
  await document.save(() => ({ bytes: bytes("最新编辑"), revision: 1 }));
  expect(document.dirty).toBe(false);
  expect(document.originalBytes).toEqual(bytes("最新编辑"));
});

it("另存副本缺少有效路径时保留当前文档，不切换到无效副本", async () => {
  const document = new ReaderDocument(createReaderApi());
  document.load("note.md", { disk: bytes("原文"), draft: null });
  document.markDirty();
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ path: null, warning: null });
  await expect(document.copy(() => ({ bytes: bytes("最新编辑"), revision: 1 }))).rejects.toThrow(
    "无法确认副本保存结果",
  );
  expect(document.path).toBe("note.md");
  expect(document.dirty).toBe(true);
  expect(document.originalBytes).toEqual(bytes("原文"));
});

it("所有阅读器响应在进入调用方前校验，错误元数据不能冒充空库、条目或导航位置", async () => {
  const api = createReaderApi();
  const requests: { read: () => Promise<unknown>; invalid: unknown }[] = [
    { read: () => api.vaultOpen(), invalid: {} },
    { read: () => api.vaultRestore(), invalid: { root: "/notes" } },
    { read: () => api.vaultList(), invalid: ["note.md", false] },
    { read: () => api.vaultEntries(), invalid: [{ path: "note.md", kind: "unknown" }] },
    { read: () => api.sessionGetPanes(), invalid: { filesCollapsed: false } },
    {
      read: () =>
        api.sessionSetDocuments({
          panes: [{ currentPath: null, history: { back: [], forward: [] } }],
          active: 0,
          split: false,
        }),
      invalid: { status: "failed" },
    },
    { read: () => api.entryCreate("new.md", "file"), invalid: {} },
    { read: () => api.entryTrash("note.md"), invalid: { warning: false } },
    { read: () => api.entryRename("note.md", "new.md"), invalid: { warning: {} } },
    { read: () => api.fileRead("note.md"), invalid: "错误的文本字节" },
    { read: () => api.linksResolve("note.md", "目标", "wiki"), invalid: false },
    { read: () => api.linksResolve("note.md", "目标", "wiki"), invalid: { status: "unknown" } },
    {
      read: () => api.linksResolve("note.md", "目标", "wiki"),
      invalid: { status: "resolved", path: "../逃逸.md", anchor: null },
    },
    {
      read: () => api.linksResolve("note.md", "目标", "wiki"),
      invalid: { status: "ambiguous", candidates: [], anchor: null },
    },
    { read: () => api.indexLinksTo("note.md"), invalid: [{}] },
    { read: () => api.indexLinksFrom("note.md"), invalid: [{}] },
    { read: () => api.indexMentionsTo("note.md"), invalid: { linked: [] } },
    { read: () => api.searchQuery(emptyQuery(), "search-id", null), invalid: [{ path: "../逃逸.md" }] },
    { read: () => api.searchMatches(emptyQuery(), "search-id", "cursor"), invalid: { matches: [], nextCursor: "more" } },
    { read: () => api.indexHeadings("note.md"), invalid: [{ path: "note.md", level: 9 }] },
    {
      read: () => api.indexNoteKeys(),
      invalid: [{ path: "../逃逸.md", title: "标题", aliases: [] }],
    },
    { read: () => api.indexNoteKeys(), invalid: [{ path: "a.md", title: "标题", aliases: [1] }] },
    { read: () => api.sessionSetRecentFiles(["a.md"]), invalid: { status: "failed" } },
    {
      read: () => api.bookmarksList(),
      invalid: [{ kind: "file", path: "../逃逸.md", title: null }],
    },
    { read: () => api.bookmarksList(), invalid: [{ kind: "tag", path: "a.md", title: null }] },
    { read: () => api.bookmarksSet([]), invalid: { status: "failed" } },
  ];
  for (const request of requests) {
    vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce(request.invalid);
    await expect(request.read()).rejects.toThrow();
  }
});

it("损坏通知作为可恢复索引状态传播，后续有效通知仍可到达且订阅可以释放", () => {
  const callback = vi.fn();
  const stop = createReaderApi().subscribeVaultChanged(callback);
  const listener: unknown = vi
    .mocked(ipcRenderer.on)
    .mock.calls.find(([name]) => name === "reader.vault.changed")?.[1];
  if (typeof listener !== "function") throw new Error("没有注册库变更监听器");
  listener(undefined, { status: "unknown" });
  expect(callback).toHaveBeenLastCalledWith({
    status: "index-error",
    paths: [],
    message: expect.stringContaining("无法识别库变更通知"),
  });
  const valid = { status: "changed", paths: ["note.md"], healthy: true };
  listener(undefined, valid);
  expect(callback).toHaveBeenLastCalledWith(valid);
  stop();
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith("reader.vault.changed", listener);
});

it("批次订阅隔离旧进度，停止核对库归属，损坏进度不丢失有效提交结果", async () => {
  const api = createReaderApi();
  const progress = vi.fn();
  const request = { root: "/notes", action: "trash" as const, paths: ["a.md", "b.md"] };
  const outcome = {
    completed: [{ from: "a.md", to: null }],
    remaining: ["b.md"],
    skipped: [],
    issues: [],
    warning: null,
  };
  let finish = () => {};
  vi.mocked(ipcRenderer.invoke).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(outcome);
      }),
  );
  const pending = api.entryBatch(request, progress);
  const id: unknown = vi.mocked(ipcRenderer.invoke).mock.calls.at(-1)?.[2];
  const listener: unknown = vi.mocked(ipcRenderer.on).mock.calls.at(-1)?.[1];
  if (typeof id !== "string" || typeof listener !== "function") throw new Error("缺少批次监听");
  await expect(api.entryBatch(request)).rejects.toThrow("等待");
  listener(undefined, "old-batch", { phase: "running", completed: 2, total: 2 });
  expect(progress).not.toHaveBeenCalled();
  listener(undefined, id, { phase: "running", completed: 5, total: 2 });
  expect(progress).not.toHaveBeenCalled();
  listener(undefined, id, { phase: "running", completed: 1, total: 2 });
  expect(progress).toHaveBeenCalledExactlyOnceWith({ phase: "running", completed: 1, total: 2 });
  await api.entryBatchStop("/other");
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce(undefined);
  await api.entryBatchStop("/notes");
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith("reader.entry.batch.stop", "/notes", id);
  finish();
  const result = await pending;
  expect(result.completed).toEqual(outcome.completed);
  expect(result.warning).toContain("进度通知异常");
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith("reader.entry.batch.progress", listener);
  await api.entryBatchStop("/notes");
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2);
});
