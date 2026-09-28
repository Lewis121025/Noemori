import { describe, expect, it, vi } from "vitest";
import type { Bookmark } from "@reader/shared/api";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function setup(initial: Bookmark[] = []) {
  let stored = initial;
  const api = createReaderApiMock({
    vaultRestore: vi.fn(async () => ({
      root: "/notes",
      documents: {
        panes: [{ currentPath: "a.md", history: { back: [], forward: [] } }],
        active: 0,
        split: false,
      },
      viewModes: {},
      recentFiles: [],
    })),
    vaultEntries: vi.fn(async () => [
      { path: "a.md", kind: "file" as const },
      { path: "b.md", kind: "file" as const },
    ]),
    fileSnapshot: vi.fn(async () => ({ disk: encode("# 甲\n\n正文\n"), draft: null })),
    bookmarksList: vi.fn(async () => stored),
    bookmarksSet: vi.fn(async (items: Bookmark[]) => {
      stored = items;
    }),
  });
  return { api, workspace: new ReaderWorkspaceController(api), stored: () => stored };
}

const fileMark = (path: string): Bookmark => ({ kind: "file", path, title: null });

describe("书签状态", () => {
  it("恢复会话后读入书签；收藏当前文件整表写回并给出确认", async () => {
    const { workspace, stored } = setup([fileMark("b.md")]);
    await workspace.restore();
    await vi.waitFor(() => expect(workspace.bookmarks.items).toEqual([fileMark("b.md")]));
    await workspace.bookmarkCurrentFile();
    expect(stored()).toEqual([fileMark("b.md"), fileMark("a.md")]);
    expect(workspace.message).toBe("已加入书签");
    await workspace.bookmarkCurrentFile();
    expect(stored()).toEqual([fileMark("b.md")]);
    expect(workspace.message).toBe("已移出书签");
  });

  it("修改开始后在途的旧读取结果被丢弃，不会把刚改的清单覆盖回去", async () => {
    const { api, workspace } = setup();
    await workspace.restore();
    let release: (items: Bookmark[]) => void = () => {};
    vi.mocked(api.bookmarksList).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const reading = workspace.bookmarks.reload();
    await workspace.bookmarks.toggle(fileMark("a.md"));
    release([]);
    await reading;
    expect(workspace.bookmarks.items).toEqual([fileMark("a.md")]);
  });

  it("写入失败时回退到磁盘上的清单，原因可见", async () => {
    const { api, workspace } = setup([fileMark("b.md")]);
    await workspace.restore();
    await vi.waitFor(() => expect(workspace.bookmarks.items).toHaveLength(1));
    vi.mocked(api.bookmarksSet).mockRejectedValueOnce(new Error("磁盘已满"));
    await workspace.bookmarkCurrentFile();
    expect(workspace.bookmarks.items).toEqual([fileMark("b.md")]);
    expect(workspace.bookmarks.error).toContain("磁盘已满");
    expect(workspace.message).not.toBe("已加入书签");
  });

  it("书签文件损坏时清单为空并说明原因，不阻塞目录刷新", async () => {
    const { api, workspace } = setup();
    vi.mocked(api.bookmarksList).mockRejectedValue(new Error("书签无效：expected value"));
    await workspace.restore();
    await vi.waitFor(() => expect(workspace.bookmarks.error).toContain("书签无效"));
    expect(workspace.bookmarks.items).toEqual([]);
    expect(workspace.files).toEqual(["a.md", "b.md"]);
  });

  it("改名后重读内核同步改写的书签；切库丢弃旧库书签", async () => {
    const { api, workspace } = setup([fileMark("a.md")]);
    await workspace.restore();
    await vi.waitFor(() => expect(workspace.bookmarks.items).toHaveLength(1));
    vi.mocked(api.entryRename).mockImplementationOnce(async () => {
      vi.mocked(api.bookmarksList).mockResolvedValue([fileMark("c.md")]);
      return { warning: null };
    });
    expect(await workspace.renameEntry("a.md", "c.md")).toBeNull();
    await vi.waitFor(() => expect(workspace.bookmarks.items).toEqual([fileMark("c.md")]));
    vi.mocked(api.vaultOpen).mockResolvedValueOnce("/other");
    vi.mocked(api.bookmarksList).mockImplementation(() => new Promise(() => {}));
    await workspace.openVault();
    expect(workspace.bookmarks.items).toEqual([]);
  });

  it("收藏标题需要选区所在章节；没有章节时提示原因且不写盘", async () => {
    const { api, workspace, stored } = setup();
    await workspace.restore();
    await workspace.bookmarkCurrentHeading();
    expect(api.bookmarksSet).not.toHaveBeenCalled();
    expect(workspace.message).toContain("光标不在任何标题下");
    expect(stored()).toEqual([]);
  });
});
