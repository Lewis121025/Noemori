/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderFileTree } from "@reader/renderer/library/state.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import { emptyFileTreeState } from "@reader/shared/file-browser";
import type { VaultEntry } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const entries: VaultEntry[] = [
  { path: "folder", kind: "directory" },
  { path: "folder/a.md", kind: "file" },
];
afterEach(() => vi.useRealTimers());

describe("持久化目录现场", () => {
  it("合并滚动写入，关闭前立即保存最新选择，保存失败允许重试", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const report = vi.fn();
    const tree = new ReaderFileTree(() => "/notes", save, report);
    tree.restore(null, entries);
    expect(tree.hasStoredState).toBe(false);
    tree.update({ expanded: ["folder"] });
    tree.update({ scroll: { path: "folder/a.md", offset: 3 } });
    await vi.advanceTimersByTimeAsync(179);
    expect(save).not.toHaveBeenCalled();
    expect(await tree.flush()).toBe(true);
    expect(save).toHaveBeenCalledExactlyOnceWith("/notes", tree.state);
    save.mockRejectedValueOnce(new Error("只读"));
    tree.update({ selected: ["folder/a.md"], focused: "folder/a.md" });
    expect(await tree.flush()).toBe(false);
    expect(report).toHaveBeenCalledWith(expect.stringContaining("只读"));
    expect(await tree.flush()).toBe(true);
    tree.reset();
  });

  it("按发送顺序保存最新现场，切库取消尚未发送的旧写入", async () => {
    let finish!: () => void;
    let root = "/notes";
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = vi.fn(async () => {});
    save.mockImplementationOnce(() => pending);
    const tree = new ReaderFileTree(() => root, save, vi.fn());
    tree.restore(emptyFileTreeState(), entries);
    expect(tree.hasStoredState).toBe(true);
    tree.update({ selected: ["folder"] });
    const first = tree.flush();
    await Promise.resolve();
    tree.update({ selected: ["folder/a.md"] });
    const second = tree.flush();
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    expect(save).toHaveBeenLastCalledWith(
      "/notes",
      expect.objectContaining({ selected: ["folder/a.md"] }),
    );
    tree.update({ expanded: ["folder"] });
    root = "/other";
    tree.restore(null, []);
    expect(await tree.flush()).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    tree.reset();
  });

  it("迟到的旧清单不能撤销新清单或删除有效选择", async () => {
    const api = createReaderApiMock({ vaultEntries: vi.fn(async () => entries) });
    const workspace = new ReaderWorkspaceController(api);
    await workspace.restore();
    let finish!: (value: VaultEntry[]) => void;
    vi.mocked(api.vaultEntries).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = workspace.refreshList();
    const added: VaultEntry = { path: "new.md", kind: "file" };
    vi.mocked(api.vaultEntries).mockResolvedValueOnce([...entries, added]);
    await workspace.refreshList();
    workspace.fileTree.update({ selected: [added.path], scroll: { path: added.path, offset: 5 } });
    finish(entries);
    await old;
    expect(workspace.entries).toContainEqual(added);
    expect(workspace.fileTree.state.selected).toEqual([added.path]);
    await workspace.flushBeforeClose();
  });
});
