/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { ViewModes } from "@reader/shared/session";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

// 与内核恢复流程同构的最小合法编辑器恢复记录。
const editorRecovery = JSON.stringify({
  format: "nous.prosemirror",
  version: 1,
  revision: 1,
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "math_inline", attrs: { tex: "" } }] }],
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

function restoring(currentPath: string | null, viewModes: ViewModes) {
  return vi.fn(async () => ({
    root: "/notes",
    entries: ["a.md", "b.md", "c.md"].map((path) => ({ path, kind: "file" as const })),
    documents: {
      panes: [{ currentPath, history: { back: [], forward: [] } }],
      active: 0,
      split: false,
    },
    viewModes,
    recentFiles: [],
  }));
}

describe("视图记忆", () => {
  it("恢复会话时按记忆直接以源码或阅读视图打开，未记住的文件回排版", async () => {
    const workspace = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: restoring("b.md", { "b.md": "source", "c.md": "reading" }),
        vaultEntries: vi.fn(async () => [
          { path: "a.md", kind: "file" as const },
          { path: "b.md", kind: "file" as const },
          { path: "c.md", kind: "file" as const },
        ]),
        fileSnapshot: vi.fn(async () => ({ disk: encode("# 笔记\n"), draft: null })),
      }),
    );
    await workspace.restore();
    expect(workspace.document.path).toBe("b.md");
    expect(workspace.viewMode).toBe("source");

    await workspace.openFile("a.md");
    expect(workspace.viewMode).toBe("wysiwyg");
    await workspace.openFile("c.md");
    expect(workspace.viewMode).toBe("reading");
  });

  it("带恢复记录的文件不进源码视图，阅读视图不受影响", async () => {
    const snapshot = {
      disk: encode("# 笔记\n"),
      draft: { bytes: encode("# 笔记\n"), base: encode("# 笔记\n"), editor: editorRecovery },
    };
    const source = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: restoring("b.md", { "b.md": "source" }),
        vaultEntries: vi.fn(async () => [{ path: "b.md", kind: "file" as const }]),
        fileSnapshot: vi.fn(async () => snapshot),
      }),
    );
    await source.restore();
    expect(source.document.needsSourceRepair).toBe(true);
    expect(source.viewMode).toBe("wysiwyg");
    const reading = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: restoring("b.md", { "b.md": "reading" }),
        vaultEntries: vi.fn(async () => [{ path: "b.md", kind: "file" as const }]),
        fileSnapshot: vi.fn(async () => snapshot),
      }),
    );
    await reading.restore();
    expect(reading.viewMode).toBe("reading");
  });

  // 跨源码边界的切换需要挂载编辑器交接文本，由 e2e 覆盖；这里只验证排版与阅读之间。
  it("切换阅读视图写入记忆，回到排版删除记忆", async () => {
    const sessionSetViewModes = vi.fn(async () => {});
    const workspace = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: restoring("a.md", {}),
        vaultEntries: vi.fn(async () => [{ path: "a.md", kind: "file" as const }]),
        fileSnapshot: vi.fn(async () => ({ disk: encode("# 笔记\n"), draft: null })),
        sessionSetViewModes,
      }),
    );
    await workspace.restore();
    await workspace.toggleReadingMode();
    expect(workspace.viewMode).toBe("reading");
    expect(sessionSetViewModes).toHaveBeenLastCalledWith({ "a.md": "reading" });
    await workspace.toggleReadingMode();
    expect(workspace.viewMode).toBe("wysiwyg");
    expect(sessionSetViewModes).toHaveBeenLastCalledWith({});
  });

  it("改名后视图记忆跟随新路径", async () => {
    const workspace = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: restoring(null, { "a.md": "source" }),
        vaultEntries: vi.fn(async () => [
          { path: "a.md", kind: "file" as const },
          { path: "renamed.md", kind: "file" as const },
        ]),
        fileSnapshot: vi.fn(async () => ({ disk: encode("# 笔记\n"), draft: null })),
      }),
    );
    await workspace.restore();
    await workspace.renameEntry("a.md", "renamed.md");
    await workspace.openFile("renamed.md");
    expect(workspace.viewMode).toBe("source");
  });
});
