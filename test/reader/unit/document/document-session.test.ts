import { describe, expect, it, vi } from "vitest";
import { ReaderDocument } from "@reader/renderer/state/document.svelte";
import type { ReaderApi, SavedCopy, WriteResult } from "@reader/shared/api";
import { MarkdownSnapshotError } from "@reader/renderer/engine/markdown/session-recovery";
import { parseMarkdown } from "@reader/renderer/engine/markdown/parse";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const snapshot = (text: string) => ({ bytes: encode(text), revision: 1 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const api: Pick<ReaderApi, "fileWrite" | "fileWriteCopy" | "filePreserveDraft"> = {
    fileWrite: vi.fn(async () => ({ status: "saved", warning: null })),
    fileWriteCopy: vi.fn(async () => ({ path: "copy.md", warning: null })),
    filePreserveDraft: vi.fn(async () => {}),
  };
  const document = new ReaderDocument(api);
  document.load("note.md", { disk: encode("base"), draft: null });
  return { document, api };
}

describe("活动文档保存契约", () => {
  it.each(["save", "copy"] as const)(
    "%s 无法生成 Markdown 时持久化同版本恢复内容，不触碰原文件或创建假副本",
    async (operation) => {
      const { document, api } = setup();
      document.markDirty();
      const error = new MarkdownSnapshotError(
        "base",
        parseMarkdown("最新编辑 👩‍💻"),
        7,
        new Error("mapping"),
      );
      const read = () => {
        throw error;
      };
      if (operation === "save") expect(await document.save(read)).toBeNull();
      else await expect(document.copy(read)).rejects.toThrow("已写入本地恢复记录");
      expect(api.filePreserveDraft).toHaveBeenCalledExactlyOnceWith(
        "note.md",
        encode("base"),
        encode("base"),
        error.recovery.editor,
      );
      expect(api.fileWrite).not.toHaveBeenCalled();
      expect(api.fileWriteCopy).not.toHaveBeenCalled();
      expect(document.dirty).toBe(true);
      expect(document.needsSourceRepair).toBe(true);
    },
  );

  it("恢复持久化也失败时不声称草稿已保存，继续编辑后可以重新提交", async () => {
    const { document, api } = setup();
    const failure = new MarkdownSnapshotError(
      "base",
      parseMarkdown("最新编辑"),
      1,
      new Error("mapping"),
    );
    document.markDirty();
    vi.mocked(api.filePreserveDraft).mockRejectedValueOnce(new Error("disk full"));
    await document.save(() => {
      throw failure;
    });
    expect(document.saveError).toContain("恢复记录也未能写入：disk full");
    expect(document.saveError).not.toContain("已写入本地恢复记录");
    expect(document.dirty).toBe(true);
    await document.save(() => snapshot("修正内容"));
    expect(document.dirty).toBe(false);
    expect(document.needsSourceRepair).toBe(false);
    expect(document.saveError).toBeNull();
  });

  it("恢复记录迟到不能修改新文档状态，期间的新输入仍未保存", async () => {
    const { document, api } = setup();
    const pending = deferred<void>();
    vi.mocked(api.filePreserveDraft).mockReturnValueOnce(pending.promise);
    document.markDirty();
    const failure = new MarkdownSnapshotError(
      "base",
      parseMarkdown("旧编辑"),
      1,
      new Error("mapping"),
    );
    const saving = document.save(() => {
      throw failure;
    });
    document.load("next.md", { disk: encode("next"), draft: null });
    document.markDirty();
    pending.resolve();
    await saving;
    expect(document.path).toBe("next.md");
    expect(document.saveError).toBeNull();
    expect(document.needsSourceRepair).toBe(false);
    expect(document.dirty).toBe(true);
  });

  it("恢复写入期间的新输入不能冒充已持久化版本，反馈明确快照范围", async () => {
    const { document, api } = setup();
    const pending = deferred<void>();
    vi.mocked(api.filePreserveDraft).mockReturnValueOnce(pending.promise);
    document.markDirty();
    const failure = new MarkdownSnapshotError(
      "base",
      parseMarkdown("保存时的编辑"),
      1,
      new Error("mapping"),
    );
    const saving = document.save(() => {
      throw failure;
    });
    document.markDirty();
    pending.resolve();
    await saving;
    expect(api.filePreserveDraft).toHaveBeenCalledExactlyOnceWith(
      "note.md",
      encode("base"),
      encode("base"),
      failure.recovery.editor,
    );
    expect(document.dirty).toBe(true);
    expect(document.saveError).toContain("本次尝试保存时的编辑");
    expect(document.saveError).toContain("后续修改需再次保存");
    document.markDirty();
    expect(document.saveError).toContain("后续修改需再次保存");
  });

  it("旧版本或损坏恢复文档拒绝加载，保留原活动文档与脏状态", () => {
    const { document } = setup();
    document.markDirty();
    for (const editor of [
      "broken",
      JSON.stringify({ format: "nous.prosemirror", version: 2 }),
      JSON.stringify({
        format: "nous.prosemirror",
        version: 1,
        revision: 1,
        doc: { type: "doc", content: [{ type: "unknown" }] },
      }),
    ]) {
      expect(() =>
        document.load("recovered.md", {
          disk: encode("original"),
          draft: { bytes: encode("original"), base: encode("original"), editor },
        }),
      ).toThrow();
      expect(document.path).toBe("note.md");
      expect(document.content).toEqual({ kind: "markdown", source: "base" });
      expect(document.dirty).toBe(true);
    }
  });

  it.each([false, true])("原路径读取失败时保留内容、基准和实际编辑状态（已编辑：%s）", (edited) => {
    const { document } = setup();
    if (edited) document.markDirty();
    const epoch = document.epoch;
    document.refresh(null, "父路径已被替换");
    expect(document.path).toBe("note.md");
    expect(document.epoch).toBe(epoch);
    expect(document.originalBytes).toEqual(encode("base"));
    expect(document.content).toEqual({ kind: "markdown", source: "base" });
    expect(document.dirty).toBe(edited);
    expect(document.conflict).toEqual({ disk: null, error: "父路径已被替换" });
  });

  it("未修改的笔记另存副本时保持原始字节，不重新序列化 Markdown", async () => {
    const { document, api } = setup();
    const original = encode("Title\r\n=====\r\n\r\n*  text\r\n");
    document.load("note.md", { disk: original, draft: null });
    const serialize = vi.fn(() => snapshot("# Title\n\n- text\n"));
    await document.copy(serialize);
    expect(serialize).not.toHaveBeenCalled();
    expect(api.fileWriteCopy).toHaveBeenCalledExactlyOnceWith("note.md", original, original);
    expect(document.originalBytes).toEqual(original);
    expect(document.dirty).toBe(false);
  });

  it("加载不存在的文件时不破坏当前编辑与保存基准", () => {
    const { document } = setup();
    document.markDirty();
    const epoch = document.epoch;
    expect(() => document.load("missing.md", { disk: null, draft: null })).toThrow("文件已不存在");
    expect(document.path).toBe("note.md");
    expect(document.epoch).toBe(epoch);
    expect(document.originalBytes).toEqual(encode("base"));
    expect(document.dirty).toBe(true);
  });

  it("文档替换后到达的写入结果不能清除新文档的未保存状态", async () => {
    const { document, api } = setup();
    const pending = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(pending.promise);
    document.markDirty();
    const save = document.save(() => snapshot("old edits"));
    document.load("other.md", { disk: encode("other"), draft: null });
    document.markDirty();
    pending.resolve({ status: "saved", warning: null });
    expect(await save).toBeNull();
    expect(document.path).toBe("other.md");
    expect(document.originalBytes).toEqual(encode("other"));
    expect(document.dirty).toBe(true);
  });

  it("序列化失败不会写入文件，也不会清除编辑", async () => {
    const { document, api } = setup();
    document.markDirty();
    expect(
      await document.save(() => {
        throw new Error("编辑器未就绪");
      }),
    ).toBeNull();
    expect(api.fileWrite).not.toHaveBeenCalled();
    expect(document.saveError).toBe("编辑器未就绪");
    expect(document.saving).toBe(false);
    expect(document.dirty).toBe(true);
  });

  it("副本写入期间的新输入保留，保存基准仅使用已写入字节", async () => {
    const { document, api } = setup();
    const pending = deferred<SavedCopy>();
    vi.mocked(api.fileWriteCopy).mockReturnValueOnce(pending.promise);
    document.markDirty();
    let text = "first";
    const copy = document.copy(() => snapshot(text));
    text = "latest";
    document.markDirty();
    pending.resolve({ path: "copy.md", warning: null });
    await copy;
    expect(document.path).toBe("copy.md");
    expect(document.content).toEqual({ kind: "markdown", source: "latest" });
    expect(document.originalBytes).toEqual(encode("first"));
    expect(document.dirty).toBe(true);
  });

  it("副本已提交后编辑器读取失败，仍返回已提交路径并保留原编辑", async () => {
    const { document, api } = setup();
    const pending = deferred<SavedCopy>();
    vi.mocked(api.fileWriteCopy).mockReturnValueOnce(pending.promise);
    document.markDirty();
    const serialize = vi.fn(() => snapshot("first"));
    const copy = document.copy(serialize);
    document.markDirty();
    serialize.mockImplementation(() => {
      throw new Error("编辑器读取失败");
    });
    pending.resolve({ path: "copy.md", warning: null });
    await expect(copy).resolves.toEqual({
      path: "copy.md",
      warning: null,
      refreshError: "编辑器读取失败",
    });
    expect(document.path).toBe("note.md");
    expect(document.originalBytes).toEqual(encode("base"));
    expect(document.dirty).toBe(true);
  });
});
