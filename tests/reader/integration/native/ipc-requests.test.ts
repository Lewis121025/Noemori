import { Worker } from "node:worker_threads";
import { beforeEach, expect, it, vi } from "vitest";
import { CoreClient } from "../../../../apps/desktop/src/main/core-client";
import { registerReaderIpc } from "@reader/main/ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const { handlers, call } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  call: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({ Worker: class {} }));
vi.mock("../../../../apps/desktop/src/main/core-client", () => ({
  CoreClient: class {
    call = call;
  },
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  dialog: {},
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}));

beforeEach(() => {
  handlers.clear();
  call.mockReset();
  call.mockResolvedValue(undefined);
  registerReaderIpc(() => null, new CoreClient(new Worker("unused"), vi.fn()));
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册通道：${channel}`);
  return handler(undefined, ...args);
}

it("错误字节和缺失基准在 IPC 入口被拒绝，不进入保存或副本执行队列", async () => {
  const bytes = new Uint8Array([0, 255]);
  for (const channel of ["reader.file.write", "reader.file.writeCopy"]) {
    for (const invalid of [[], "内容", 100, undefined, null]) {
      await expect(invoke(channel, "笔记.md", invalid, bytes)).rejects.toThrow("字节");
      if (invalid !== null)
        await expect(invoke(channel, "笔记.md", bytes, invalid)).rejects.toThrow("字节");
    }
  }
  expect(call).not.toHaveBeenCalled();
  await invoke("reader.file.write", "空笔记.md", new Uint8Array(), null);
  expect(call).toHaveBeenLastCalledWith("fileWrite", "空笔记.md", new Uint8Array(), null);
  await invoke("reader.file.writeCopy", "笔记.md", bytes, bytes);
  expect(call).toHaveBeenLastCalledWith("fileWriteCopy", "笔记.md", bytes, bytes);
});

it("错误会话参数不能清空当前路径或重置布局，额外字段不能修改库路径", async () => {
  await expect(invoke("reader.session.setDocuments", {})).rejects.toThrow("文档会话");
  await expect(invoke("reader.session.setDocuments", undefined)).rejects.toThrow("文档会话");
  await expect(
    invoke("reader.session.setDocuments", {
      panes: [{ currentPath: "../逃逸.md", history: { back: [], forward: [] } }],
      active: 0,
      split: false,
    }),
  ).rejects.toThrow("路径");
  await expect(invoke("reader.session.setPanes", {})).rejects.toThrow("布局");
  expect(call).not.toHaveBeenCalled();
  const documents = {
    panes: [{ currentPath: null, history: { back: [], forward: [] } }],
    active: 0,
    split: false,
  };
  await invoke("reader.session.setDocuments", documents);
  expect(call).toHaveBeenLastCalledWith("readerSessionPatch", { documents });
  await invoke("reader.session.setPanes", {
    filesCollapsed: true,
    leftWidth: 240,
    vaultRoot: "/不允许注入",
  });
  expect(call).toHaveBeenLastCalledWith("readerSessionPatch", {
    filesCollapsed: true,
    leftWidth: 240,
  });
  // 视图记忆逐项校验：未知视图与空路径丢弃，不整体拒绝。
  await invoke("reader.session.setViewModes", { "a.md": "source", "b.md": 5, "": "reading" });
  expect(call).toHaveBeenLastCalledWith("readerSessionPatch", { viewModes: { "a.md": "source" } });
  // 最近列表同一口径：保序去重，不能借此写入其他会话字段。
  await invoke("reader.session.setRecentFiles", ["b.md", null, "a.md", "b.md"]);
  expect(call).toHaveBeenLastCalledWith("readerSessionPatch", { recentFiles: ["b.md", "a.md"] });
  await invoke("reader.index.noteKeys");
  expect(call).toHaveBeenLastCalledWith("indexNoteKeys");
  await expect(invoke("reader.index.graph", "true")).rejects.toThrow("图谱");
  await invoke("reader.index.graph", true);
  expect(call).toHaveBeenLastCalledWith("indexGraph", true);
  // 书签整体校验：越界路径、空查询与多余字段不能写进库内书签文件。
  call.mockClear();
  for (const invalid of [
    null,
    [{ kind: "file", path: "../逃逸.md", title: null }],
    [{ kind: "search", query: " ", title: null }],
    [{ kind: "heading", path: "a.md", heading: "", title: null }],
  ])
    await expect(invoke("reader.bookmarks.set", invalid)).rejects.toThrow("书签");
  expect(call).not.toHaveBeenCalled();
  await invoke("reader.bookmarks.set", [
    { kind: "heading", path: "a.md", heading: "目标", title: null, extra: 1 },
  ]);
  expect(call).toHaveBeenLastCalledWith("bookmarksSet", [
    { kind: "heading", path: "a.md", heading: "目标", title: null },
  ]);
});

it("读取、预览、索引和文件操作统一拒绝错误路径与未知种类", async () => {
  for (const channel of [
    "reader.file.read",
    "reader.file.snapshot",
    "reader.index.linksTo",
    "reader.index.linksFrom",
    "reader.index.mentionsTo",
    "reader.index.headings",
    "reader.entry.trash",
    "reader.entry.reveal",
  ])
    await expect(invoke(channel, {})).rejects.toThrow("路径");
  await expect(invoke("reader.entry.create", "目录", "unknown")).rejects.toThrow("类型");
  await expect(invoke("reader.entry.rename", "原名.md", null)).rejects.toThrow("路径");
  await expect(invoke("reader.links.resolve", "原名.md", "目标", "unknown")).rejects.toThrow(
    "语法",
  );
  await expect(invoke("reader.links.resolve", "原名.md", {}, "wiki")).rejects.toThrow("目标");
  expect(call).not.toHaveBeenCalled();
  await invoke("reader.links.resolve", "原名.md", "标题#定位", "wiki");
  expect(call).toHaveBeenLastCalledWith("linksResolve", "原名.md", "标题#定位", "wiki");
});

it("检索条件在 IPC 入口结构化校验，超界上限被收敛后才进入内核", async () => {
  let deep: unknown = { kind: "term", value: "x" };
  for (let depth = 0; depth < 40; depth += 1) deep = { kind: "not", child: deep };
  for (const invalid of [
    undefined,
    "原始查询串",
    { expr: { kind: "term", value: 1 }, limit: 10 },
    { expr: { kind: "attr", value: "v" }, limit: 10 },
    { expr: { kind: "and", children: "x" }, limit: 10 },
    { expr: { kind: "unknown" }, limit: 10 },
    { expr: { kind: "and", children: [] }, limit: "10" },
    { expr: deep, limit: 10 },
  ])
    await expect(invoke("reader.search.query", invalid)).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
  const expr = {
    kind: "and",
    children: [
      { kind: "term", value: "全文" },
      { kind: "not", child: { kind: "tag", value: "#标签" } },
      { kind: "attr", key: "status", value: null },
    ],
  };
  await invoke("reader.search.query", { expr, limit: 1e9 });
  expect(call).toHaveBeenLastCalledWith("searchQuery", { expr, limit: 500 });
});

it("提及转链接的区间与文本在 IPC 入口校验后才进入内核", async () => {
  await expect(invoke("reader.index.linkifyMention", {}, 0, 1, "文本", "目标.md")).rejects.toThrow(
    "路径",
  );
  await expect(
    invoke("reader.index.linkifyMention", "ref.md", -1, 1, "文本", "目标.md"),
  ).rejects.toThrow("范围");
  await expect(
    invoke("reader.index.linkifyMention", "ref.md", 0, 1.5, "文本", "目标.md"),
  ).rejects.toThrow("范围");
  await expect(invoke("reader.index.linkifyMention", "ref.md", 0, 1, 5, "目标.md")).rejects.toThrow(
    "文本",
  );
  expect(call).not.toHaveBeenCalled();
  // 库根约束由内核统一执行；IPC 层与其他路径参数同一口径。
  await invoke("reader.index.linkifyMention", "ref.md", 0, 6, "目标", "目标.md");
  expect(call).toHaveBeenLastCalledWith("mentionsLinkify", "ref.md", 0, 6, "目标", "目标.md");
});
