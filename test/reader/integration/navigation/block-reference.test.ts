import { describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/state/workspace.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function setup(target: string) {
  let disk = encode(target);
  const api = createReaderApiMock({
    vaultRestore: vi.fn(async () => ({
      root: "/notes",
      documents: {
        panes: [{ currentPath: "host.md", history: { back: [], forward: [] } }],
        active: 0,
        split: false,
      },
      viewModes: {},
      recentFiles: [],
    })),
    vaultEntries: vi.fn(async () => [
      { path: "host.md", kind: "file" as const },
      { path: "target.md", kind: "file" as const },
    ]),
    fileSnapshot: vi.fn(async () => ({ disk: encode("# 宿主\n"), draft: null })),
    linksResolve: vi.fn(async (_from: string, raw: string) =>
      raw === "host"
        ? { status: "resolved" as const, path: "host.md", anchor: null }
        : { status: "resolved" as const, path: "target.md", anchor: null },
    ),
    fileRead: vi.fn(async () => disk),
    fileWrite: vi.fn(async (_path: string, bytes: Uint8Array) => {
      disk = bytes;
      return { status: "saved" as const, warning: null };
    }),
  });
  return { api, workspace: new ReaderWorkspaceController(api), disk: () => decode(disk) };
}

describe("引用其他笔记的块", () => {
  it("列出目标的块；选择没有 ID 的块时以读取字节为基准写入新 ID", async () => {
    const { api, workspace, disk } = setup("第一段\n\n第二段 ^keep\n");
    await workspace.restore();
    const pane = workspace.activePane;
    const target = await pane.suggestBlocks("target", "wiki");
    expect(target).toMatchObject({ kind: "file", path: "target.md" });
    if (target?.kind !== "file") throw new Error("应解析到其他笔记");
    expect(target.blocks.map((block) => [block.text, block.id])).toEqual([
      ["第一段", null],
      ["第二段", "keep"],
    ]);
    expect(await pane.ensureBlockId("target.md", target.blocks[1]!)).toBe("keep");
    expect(api.fileWrite).not.toHaveBeenCalled();
    const id = await pane.ensureBlockId("target.md", target.blocks[0]!);
    expect(id).toMatch(/^[0-9a-z]{6}$/);
    expect(disk()).toBe(`第一段 ^${id}\n\n第二段 ^keep\n`);
    expect(api.fileWrite).toHaveBeenCalledWith(
      "target.md",
      expect.any(Uint8Array),
      encode("第一段\n\n第二段 ^keep\n"),
    );
  });

  it("目标已变化或写入冲突时不返回 ID，并给出可见原因", async () => {
    const { api, workspace } = setup("原段落\n");
    await workspace.restore();
    const pane = workspace.activePane;
    const target = await pane.suggestBlocks("target", "wiki");
    if (target?.kind !== "file") throw new Error("应解析到其他笔记");
    const stale = { ...target.blocks[0]!, text: "别的段落" };
    expect(await pane.ensureBlockId("target.md", stale)).toBeNull();
    expect(workspace.message).toContain("目标笔记已变化");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({ status: "conflict", disk: null });
    expect(await pane.ensureBlockId("target.md", target.blocks[0]!)).toBeNull();
    expect(workspace.message).toContain("刚被修改");
  });

  it("恢复会话后别名缓存可用，供补全同步读取", async () => {
    const { api, workspace } = setup("x\n");
    // 真实 IPC 的结果晚于恢复流程的后续步骤到达。
    vi.mocked(api.indexNoteKeys).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ path: "target.md", title: "目标", aliases: ["路线图"] }]), 5),
        ),
    );
    await workspace.restore();
    await vi.waitFor(() =>
      expect(workspace.noteKeys).toEqual([
        { path: "target.md", title: "目标", aliases: ["路线图"] },
      ]),
    );
  });

  it("空目标或解析到本笔记时交给编辑器处理", async () => {
    const { workspace } = setup("x\n");
    await workspace.restore();
    expect(await workspace.activePane.suggestBlocks("", "wiki")).toEqual({ kind: "self" });
    expect(await workspace.activePane.suggestBlocks("host", "wiki")).toEqual({ kind: "self" });
  });
});
