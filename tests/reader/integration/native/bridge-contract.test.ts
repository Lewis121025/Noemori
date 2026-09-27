import { beforeEach, expect, it, vi } from "vitest";
import { ipcRenderer } from "electron";
import { createReaderApi } from "@reader/preload/api";
import { ReaderDocument } from "@reader/renderer/state/document.svelte";

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
    { read: () => api.searchQuery(emptyQuery()), invalid: [{ path: "../逃逸.md" }] },
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
    {
      read: () => api.indexGraph(false),
      invalid: { nodes: [{ path: "../逃逸.md", title: "", tags: [], dead: false }], edges: [] },
    },
    {
      read: () => api.indexGraph(false),
      invalid: {
        nodes: [{ path: "a.md", title: "甲", tags: [], dead: false }],
        edges: [{ from: "a.md", to: "不存在.md", count: 1 }],
      },
    },
    {
      read: () => api.indexGraph(false),
      invalid: {
        nodes: [{ path: "a.md", title: "甲", tags: [], dead: false }],
        edges: [{ from: "a.md", to: "a.md", count: 0 }],
      },
    },
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
