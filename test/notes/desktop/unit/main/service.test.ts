import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreService } from "../../../../../modules/notes/packages/desktop/src/main/core-service";
const { native, control } = vi.hoisted(() => ({
  native: {
    generation: "1",
    vaultOpen: vi.fn(),
    vaultRestore: vi.fn(),
    entryBatch: vi.fn(),
    fileRead: vi.fn(),
    fileSnapshot: vi.fn(),
    fileWrite: vi.fn(),
    searchQuery: vi.fn(),
    searchMatches: vi.fn(),
    indexHeadings: vi.fn(),
    indexNoteKeys: vi.fn(),
    bookmarksList: vi.fn(),
    bookmarksSet: vi.fn(),
    attachmentImport: vi.fn(),
  },
  control: {
    cancel: vi.fn(),
    cancelled: false,
    progress: { phase: "checking", completed: 0, total: 0 },
  },
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    NativeRuntime: class {
      constructor() {
        return native;
      }
    },
    NativeControl: class {
      constructor() {
        return control;
      }
    },
  }),
}));
beforeEach(() => vi.resetAllMocks());

describe("Rust Promise 与阅读器协议适配", () => {
  it("开库直接返回已准备快照，不在提交后额外扫描或重写会话", async () => {
    native.vaultOpen.mockResolvedValue({
      root: "/notes",
      entries: [{ path: "a.md", kind: "file" }],
    });
    const service = createCoreService("/state", vi.fn());
    expect(await service.vaultOpen("/notes")).toEqual({
      root: "/notes",
      entries: [{ path: "a.md", kind: "file" }],
    });
    expect(native.vaultOpen).toHaveBeenCalledExactlyOnceWith("/notes", control);
    native.vaultOpen.mockResolvedValue(null);
    expect(await service.vaultOpen("/other")).toBeNull();
    native.vaultOpen.mockRejectedValue(new Error("会话提交失败"));
    await expect(service.vaultOpen("/other")).rejects.toThrow("会话提交失败");
  });
  it("读取、草稿与冲突结果拥有独立字节，保存输入不分离也不复用", async () => {
    const original = Buffer.from([1, 2]);
    native.fileRead.mockResolvedValue(original);
    native.fileSnapshot.mockResolvedValue({
      disk: original,
      draft: { bytes: original, base: original },
    });
    native.fileWrite.mockResolvedValue({ status: "conflict", disk: original });
    const service = createCoreService("/state", vi.fn());
    const input = new Uint8Array([3, 4]);
    const base = new Uint8Array([5, 6]);
    const read = await service.fileRead("a.md");
    const snapshot = await service.fileSnapshot("a.md");
    const save = service.fileWrite("a.md", input, base);
    input[0] = 9;
    base[0] = 9;
    expect(native.fileWrite).toHaveBeenCalledExactlyOnceWith(
      "a.md",
      Buffer.from([3, 4]),
      Buffer.from([5, 6]),
    );
    const result = await save;
    original[0] = 8;
    expect(read).toEqual(new Uint8Array([1, 2]));
    expect(snapshot).toEqual({
      disk: new Uint8Array([1, 2]),
      draft: { bytes: new Uint8Array([1, 2]), base: new Uint8Array([1, 2]) },
    });
    expect(result).toEqual({ status: "conflict", disk: new Uint8Array([1, 2]) });
    expect(input.byteLength).toBe(2);
    expect(base.byteLength).toBe(2);
  });
  it("非法响应与错误字节不能被当作有效正文、标题或提交结果", async () => {
    const service = createCoreService("/state", vi.fn());
    for (const invalid of ["内容", [], 42, null]) {
      native.fileRead.mockResolvedValue(invalid);
      await expect(service.fileRead("a.md")).rejects.toThrow();
      native.fileSnapshot.mockResolvedValue({
        disk: Buffer.from("正文"),
        draft: { bytes: invalid },
      });
      await expect(service.fileSnapshot("a.md")).rejects.toThrow();
    }
    native.fileWrite.mockResolvedValue({ status: "unknown" });
    await expect(service.fileWrite("a.md", new Uint8Array(), null)).rejects.toThrow();
    native.indexHeadings.mockResolvedValue([
      { path: "a.md", level: 99, text: "标题", startByte: 0, endByte: 3 },
    ]);
    await expect(service.indexHeadings("a.md")).rejects.toThrow();
    native.indexNoteKeys.mockResolvedValue([{ path: "a.md", title: 1, aliases: [] }]);
    await expect(service.indexNoteKeys()).rejects.toThrow();
  });
  it("批量操作返回完整的部分结果，错误归属不能隐藏为成功", async () => {
    const service = createCoreService("/state", vi.fn());
    const result = {
      completed: [{ from: "a.md", to: "target/a.md" }],
      remaining: ["b.md"],
      skipped: [],
      issues: [{ path: "b.md", message: "目标冲突" }],
      warning: "会话更新失败",
    };
    native.entryBatch.mockResolvedValue(result);
    const request = {
      action: "move" as const,
      root: "/notes",
      paths: ["a.md", "b.md"],
      destination: "target",
    };
    expect(await service.entryBatch(request)).toEqual(result);
    expect(native.entryBatch).toHaveBeenCalledExactlyOnceWith(request, control);
    native.entryBatch.mockResolvedValue({ ...result, remaining: ["a.md"] });
    await expect(service.entryBatch(request)).rejects.toThrow();
  });
  it("搜索表达式与分页保持协议形态，空值不混入可选原生字段", async () => {
    const service = createCoreService("/state", vi.fn());
    const query = { expr: { kind: "attr" as const, key: "status", value: null }, limit: 10 };
    native.searchQuery.mockResolvedValue({ hits: [], nextCursor: null });
    expect(await service.searchQuery(query, "q", null)).toEqual({ hits: [], nextCursor: null });
    expect(native.searchQuery).toHaveBeenCalledWith(
      { expr: { kind: "attr", key: "status" }, limit: 10 },
      "q",
      null,
    );
    native.searchMatches.mockResolvedValue({
      matches: [{ location: null, snippet: "片段" }],
      nextCursor: null,
    });
    expect(await service.searchMatches(query, "q", "cursor")).toEqual({
      matches: [{ location: null, snippet: "片段" }],
      nextCursor: null,
    });
  });
  it("附件请求携带根目录并复制原字节，书签缺省值保持兼容", async () => {
    const service = createCoreService("/state", vi.fn());
    native.attachmentImport.mockResolvedValue({ path: "attachments/a.png" });
    const bytes = new Uint8Array([0, 255]);
    expect(await service.attachmentImport("/notes", "a.md", "a.png", bytes)).toEqual({
      path: "attachments/a.png",
      warning: null,
    });
    expect(native.attachmentImport).toHaveBeenCalledWith(
      "/notes",
      "a.md",
      "a.png",
      Buffer.from(bytes),
    );
    native.bookmarksList.mockResolvedValue([{ kind: "file", path: "a.md" }]);
    expect(await service.bookmarksList()).toEqual([{ kind: "file", path: "a.md", title: null }]);
    await service.bookmarksSet([{ kind: "file", path: "a.md", title: null }]);
    expect(native.bookmarksSet).toHaveBeenCalledWith([{ kind: "file", path: "a.md" }]);
  });
});
