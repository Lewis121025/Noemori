/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/state/workspace.svelte";
import type { VaultEntry } from "@reader/shared/api";
import type { EntryBatchRequest, EntryBatchResult } from "@reader/shared/entry-batch";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let api: ReturnType<typeof createReaderApiMock>;
let workspace: ReaderWorkspaceController;
let entries: VaultEntry[];
const request: EntryBatchRequest = {
  root: "/notes",
  action: "move",
  paths: ["a.md", "b.md"],
  destination: "target",
};
const partial: EntryBatchResult = {
  completed: [{ from: "a.md", to: "target/a.md" }],
  remaining: ["b.md"],
  skipped: [],
  issues: [{ path: "b.md", message: "目标被外部程序占用" }],
  warning: null,
};

beforeEach(async () => {
  entries = [
    { path: "a.md", kind: "file" },
    { path: "b.md", kind: "file" },
    { path: "target", kind: "directory" },
  ];
  api = createReaderApiMock({
    vaultEntries: vi.fn(async () => entries),
    entryBatch: vi.fn(async () => {
      entries = entries.map((entry) =>
        entry.path === "a.md" ? { ...entry, path: "target/a.md" } : entry,
      );
      return structuredClone(partial);
    }),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  await workspace.openFile("a.md");
  await workspace.openInOtherPane("b.md");
});
afterEach(() => workspace.fileTree.reset());

describe("批量写入与分栏保存契约", () => {
  it("全部分栏只保存一次，已提交路径迁移，失败项与选中状态保留", async () => {
    for (const pane of workspace.panes) {
      vi.spyOn(pane.navigation, "snapshot").mockReturnValue({
        bytes: new TextEncoder().encode(`# ${pane.document.path}\n修改\n`),
        revision: 1,
      });
      pane.document.markDirty();
    }
    workspace.fileTree.update({
      selected: ["a.md", "b.md"],
      focused: "a.md",
      scroll: { path: "a.md", offset: 2 },
    });
    expect(await workspace.batchEntries(request)).toEqual(partial);
    expect(api.fileWrite).toHaveBeenCalledTimes(2);
    expect(api.entryBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.fileWrite).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(api.entryBatch).mock.invocationCallOrder[0]!,
    );
    expect(workspace.panes.map((pane) => pane.document.path)).toEqual(["target/a.md", "b.md"]);
    expect(workspace.fileTree.state.selected).toEqual(["target/a.md", "b.md"]);
    expect(workspace.fileTree.state.scroll).toEqual({ path: "target/a.md", offset: 2 });
    expect(api.sessionSetFileTree).toHaveBeenLastCalledWith("/notes", workspace.fileTree.state);
  });

  it("任一栏保存失败则整批不执行，未保存正文及选择仍可重试", async () => {
    const pane = workspace.panes[1]!;
    vi.spyOn(pane.navigation, "snapshot").mockReturnValue({
      bytes: new TextEncoder().encode("未保存\n"),
      revision: 1,
    });
    pane.document.markDirty();
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new Error("只读"));
    const result = await workspace.batchEntries(request);
    expect(result.completed).toEqual([]);
    expect(result.remaining).toEqual(request.paths);
    expect(result.issues[0]?.message).toContain("当前编辑尚未保存");
    expect(api.entryBatch).not.toHaveBeenCalled();
    expect(pane.document.dirty).toBe(true);
    expect((await workspace.batchEntries(request)).completed).toEqual(partial.completed);
  });

  it("提交后界面刷新失败以警告返回，不能把成功项加入重试清单", async () => {
    vi.mocked(api.vaultEntries).mockRejectedValueOnce(new Error("目录暂不可读"));
    const next = await workspace.batchEntries(request);
    expect(next.completed).toEqual(partial.completed);
    expect(next.remaining).toEqual(["b.md"]);
    expect(next.warning).toContain("界面更新失败");
  });

  it("旧库请求在保存门禁后拒绝，不触碰新库", async () => {
    const result = await workspace.batchEntries({ ...request, root: "/other" });
    expect(result.issues[0]?.message).toContain("笔记库已切换");
    expect(api.entryBatch).not.toHaveBeenCalled();
  });

  it("文件已完成但目录现场保存失败时保留文档，用警告说明而不是重试成功项", async () => {
    workspace.fileTree.update({ selected: ["a.md", "b.md"] });
    vi.mocked(api.sessionSetFileTree)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("会话目录只读"));
    const result = await workspace.batchEntries(request);
    expect(result.completed).toEqual(partial.completed);
    expect(result.remaining).toEqual(["b.md"]);
    expect(result.warning).toContain("目录状态未能保存");
    expect(workspace.panes.map((pane) => pane.document.path)).toEqual(["target/a.md", "b.md"]);
  });
});
