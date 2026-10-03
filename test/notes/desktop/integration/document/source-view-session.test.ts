/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import {
  MarkdownSnapshotError,
  restoreMarkdownRecovery,
} from "@reader/renderer/markdown/session-recovery";
import type { ViewModes } from "@reader/shared/session";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

// 与内核恢复流程同构的最小合法编辑器恢复记录。
const editorRecovery = JSON.stringify({
  format: "noemori.prosemirror",
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
  it("源码视图仍按文件记忆，旧阅读视图不再覆盖全局编辑模式", async () => {
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
    expect(workspace.viewMode).toBe("wysiwyg");
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
  it("切换模式通知布局持久化，并在打开其他笔记时保持统一模式", async () => {
    const sessionSetViewModes = vi.fn(async () => {});
    const modeChanged = vi.fn();
    const workspace = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: restoring("a.md", {}),
        vaultEntries: vi.fn(async () => [{ path: "a.md", kind: "file" as const }]),
        fileSnapshot: vi.fn(async () => ({ disk: encode("# 笔记\n"), draft: null })),
        sessionSetViewModes,
      }),
      modeChanged,
    );
    await workspace.restore();
    modeChanged.mockClear();
    await workspace.toggleReadingMode();
    expect(workspace.viewMode).toBe("reading");
    expect(modeChanged).toHaveBeenCalledOnce();
    await workspace.openFile("b.md");
    expect(workspace.viewMode).toBe("reading");
    await workspace.toggleReadingMode();
    expect(workspace.viewMode).toBe("wysiwyg");
    expect(modeChanged).toHaveBeenCalledTimes(2);
    expect(sessionSetViewModes).not.toHaveBeenCalled();
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

it("阅读中的恢复草稿即使无法保存，也能回到编辑修复且不丢内容", async () => {
  const workspace = new ReaderWorkspaceController(
    createReaderApiMock({
      vaultRestore: restoring("a.md", { "a.md": "reading" }),
      fileSnapshot: vi.fn(async () => ({
        disk: encode("# 原文\n"),
        draft: { bytes: encode("# 原文\n"), base: encode("# 原文\n"), editor: editorRecovery },
      })),
    }),
  );
  await workspace.restore();
  vi.spyOn(workspace.navigation, "snapshot").mockImplementation(() => {
    throw new MarkdownSnapshotError(
      "# 原文\n",
      restoreMarkdownRecovery(editorRecovery).doc,
      1,
      new Error("空公式不能保存"),
    );
  });
  const content = workspace.document.content;
  expect(workspace.mode).toBe("reading");
  expect(workspace.document.needsSourceRepair).toBe(true);
  await workspace.toggleReadingMode();
  expect(workspace.mode).toBe("editing");
  expect(workspace.document.content).toBe(content);
  expect(workspace.document.dirty).toBe(true);
  expect(workspace.document.needsSourceRepair).toBe(true);
});
