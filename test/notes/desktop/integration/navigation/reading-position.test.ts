/** @vitest-environment jsdom */
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import { ReaderDocument } from "@reader/renderer/document/state.svelte";
import { ReaderNavigation } from "@reader/renderer/navigation/state.svelte";
import type { CodeEditorApi } from "@reader/renderer/editor/editor-api";
import type { EditorPosition } from "@reader/renderer/editor/editor-position";
import { captureSourcePoint } from "@reader/renderer/document/source-point";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const source = "# 长文\n\n" + "阅读正文。\n\n".repeat(200);
const bytes = new TextEncoder().encode(source);
const position = (offset: number): EditorPosition => ({
  reading: { source: captureSourcePoint(source, offset), inset: 8 },
  selection: { anchor: offset, head: offset + 4 },
});

function editor(at: EditorPosition): CodeEditorApi {
  return {
    history: () => false,
    historyAvailability: () => null,
    focus: vi.fn(),
    openSearch: () => {},
    snapshot: () => ({ bytes, revision: 0 }),
    capturePosition: () => at,
    restorePosition: vi.fn(async () => {}),
    jumpToByte: () => {},
    jumpToSearch: () => {},
  };
}

function navigation() {
  const document = new ReaderDocument(createReaderApiMock());
  document.load("长文.md", { disk: bytes, draft: null });
  return { document, navigation: new ReaderNavigation(document) };
}

describe("阅读位置的归属与恢复时机", () => {
  it("挂载前保留会话位置，表面注册后只恢复一次", async () => {
    const { navigation: nav } = navigation();
    const saved = position(280);
    await nav.restorePosition(saved);
    expect(nav.capturePosition()).toEqual(saved);
    const surface = editor(saved);
    nav.registerCode(surface);
    await tick();
    expect(surface.restorePosition).toHaveBeenCalledTimes(1);
    expect(surface.restorePosition).toHaveBeenCalledWith(saved, expect.any(Function));
    nav.registerCode(surface);
    expect(surface.restorePosition).toHaveBeenCalledTimes(1);
  });

  it("新文档不能兑现旧文档尚未挂载的恢复请求", async () => {
    const { document, navigation: nav } = navigation();
    await nav.restorePosition(position(280));
    document.load("另一篇.md", { disk: bytes, draft: null });
    const surface = editor(position(0));
    nav.registerCode(surface);
    await tick();
    expect(surface.restorePosition).not.toHaveBeenCalled();
    expect(nav.capturePosition()).toEqual(position(0));
  });

  it("布局等待期间显式导航取消旧恢复，迟到的滚动不覆盖用户选择", async () => {
    const { navigation: nav } = navigation();
    const surface = editor(position(0));
    const layout = Promise.withResolvers<void>();
    const applied = vi.fn();
    surface.restorePosition = vi.fn(async (_position, current) => {
      await layout.promise;
      if (current()) applied();
    });
    nav.registerCode(surface);
    const restoring = nav.restorePosition(position(400));
    await vi.waitFor(() => expect(surface.restorePosition).toHaveBeenCalledTimes(1));
    nav.jumpOutline(1);
    layout.resolve();
    await restoring;
    expect(applied).not.toHaveBeenCalled();
  });

  it("恢复中的读取继续返回目标位置，不把未完成布局的文首写回会话", async () => {
    const { navigation: nav } = navigation();
    const surface = editor(position(0));
    const layout = Promise.withResolvers<void>();
    surface.restorePosition = () => layout.promise;
    nav.registerCode(surface);
    const restoring = nav.restorePosition(position(400));
    await tick();
    expect(nav.capturePosition()).toEqual(position(400));
    layout.resolve();
    await restoring;
  });

  it.each(["navigate", "scroll", "edit", "replace"])(
    "字体尚未就绪时的 %s 使已登记的旧锚点失效",
    async (action) => {
      const { document, navigation: nav } = navigation();
      const surface = editor(position(0));
      nav.registerCode(surface);
      const layout = Promise.withResolvers<void>();
      const restoring = nav.restorePosition(position(400), layout.promise);
      await tick();
      expect(surface.restorePosition).not.toHaveBeenCalled();
      if (action === "navigate") nav.jumpOutline(1);
      else if (action === "scroll") nav.cancelPositionRestore();
      else if (action === "edit") document.markDirty();
      else document.load("另一篇.md", { disk: bytes, draft: null });
      layout.resolve();
      await restoring;
      expect(surface.restorePosition).not.toHaveBeenCalled();
    },
  );

  it("字体准备与表面挂载无论先后，都只在两个条件满足后恢复一次", async () => {
    const { navigation: nav } = navigation();
    const layout = Promise.withResolvers<void>();
    await nav.restorePosition(position(400), layout.promise);
    const surface = editor(position(0));
    nav.registerCode(surface);
    await tick();
    expect(surface.restorePosition).not.toHaveBeenCalled();
    layout.resolve();
    await vi.waitFor(() => expect(surface.restorePosition).toHaveBeenCalledTimes(1));
    nav.registerCode(surface);
    expect(surface.restorePosition).toHaveBeenCalledTimes(1);
  });

  it("用户开始输入后取消布局校正，不把旧锚点套在已变化的源码上", async () => {
    const { document, navigation: nav } = navigation();
    const surface = editor(position(0));
    const layout = Promise.withResolvers<void>();
    const applied = vi.fn();
    surface.restorePosition = vi.fn(async (_position, current) => {
      await layout.promise;
      if (current()) applied();
    });
    nav.registerCode(surface);
    const restoring = nav.restorePosition(position(400));
    await vi.waitFor(() => expect(surface.restorePosition).toHaveBeenCalled());
    document.markDirty();
    layout.resolve();
    await restoring;
    expect(applied).not.toHaveBeenCalled();
  });
});

describe("关窗阅读现场", () => {
  async function workspace() {
    const api = createReaderApiMock({
      vaultEntries: async () => [{ kind: "file", path: "长文.md" }],
      fileSnapshot: async () => ({ disk: bytes, draft: null }),
      vaultRestore: async () => ({
        root: "/notes",
        entries: await api.vaultEntries(),
        documents: {
          panes: [280, 640].map((offset) => ({
            currentPath: "长文.md",
            history: { back: [], forward: [] },
            position: position(offset).reading!,
          })),
          active: 1,
          split: true,
        },
        viewModes: {},
        recentFiles: [],
        fileTree: null,
      }),
    });
    const workspace = new ReaderWorkspaceController(api);
    await workspace.restore();
    return { api, workspace };
  }

  it("同一文件的两个分栏各自恢复、各自保存，关窗等待会话写入完成", async () => {
    const { api, workspace: work } = await workspace();
    const surfaces = [editor(position(320)), editor(position(720))];
    work.panes.forEach((pane, index) => pane.navigation.registerCode(surfaces[index]!));
    await tick();
    expect(surfaces[0]!.restorePosition).toHaveBeenCalledWith(
      { ...position(280), selection: null },
      expect.any(Function),
    );
    expect(surfaces[1]!.restorePosition).toHaveBeenCalledWith(
      { ...position(640), selection: null },
      expect.any(Function),
    );
    const writing = Promise.withResolvers<void>();
    vi.mocked(api.sessionSetDocuments).mockReturnValueOnce(writing.promise);
    let closed = false;
    const closing = work.flushBeforeClose().then((ready) => {
      closed = ready;
    });
    await vi.waitFor(() =>
      expect(api.sessionSetDocuments).toHaveBeenLastCalledWith({
        panes: [320, 720].map((offset) => ({
          currentPath: "长文.md",
          history: { back: [], forward: [] },
          position: position(offset).reading,
          outlineCollapsed: false,
        })),
        active: 1,
        split: true,
      }),
    );
    expect(closed).toBe(false);
    writing.resolve();
    await closing;
    expect(closed).toBe(true);
  });

  it("会话写入失败保留窗口并说明原因，可重试关闭", async () => {
    const { api, workspace: work } = await workspace();
    vi.mocked(api.sessionSetDocuments).mockRejectedValueOnce(new Error("磁盘暂不可写"));
    expect(await work.flushBeforeClose()).toBe(false);
    expect(work.message).toContain("阅读现场未能保存");
    expect(work.message).toContain("磁盘暂不可写");
    expect(await work.flushBeforeClose()).toBe(true);
  });
});
