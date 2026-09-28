/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { createHtmlNodeViews } from "@reader/renderer/engine/rendering/html-view";
import { createImageNodeViews } from "@reader/renderer/engine/rendering/image-view";
import { mathNodeViews } from "@reader/renderer/engine/rendering/math-view";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { observeViewport } from "@reader/renderer/engine/rendering/viewport";
import { editSelectedSource, sourceEditingPlugin } from "@reader/renderer/engine/editing/source-editing";

const { visibility, renderTex, peekRenderedTex } = vi.hoisted(() => ({
  visibility: new Map<HTMLElement, (visible: boolean) => void>(),
  renderTex: vi.fn<(...args: unknown[]) => Promise<HTMLElement>>(),
  peekRenderedTex: vi.fn(() => null),
}));

vi.mock("@reader/renderer/engine/rendering/viewport", () => ({
  observeViewport: vi.fn((element: HTMLElement, listener: (visible: boolean) => void) => {
    visibility.set(element, listener);
    return () => visibility.delete(element);
  }),
  mathPlaceholderText: (tex: string, display: boolean) => (display ? `$$${tex}$$` : `$${tex}$`),
}));
vi.mock("@reader/renderer/engine/rendering/mathjax", () => ({ renderTex, peekRenderedTex }));

const views = new Set<EditorView>();
const revokeUrl = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  renderTex.mockImplementation(async () => document.createElement("span"));
  vi.stubGlobal(
    "URL",
    class extends URL {
      static revokeObjectURL = revokeUrl;
    },
  );
});

afterEach(() => {
  for (const view of views) view.destroy();
  views.clear();
  visibility.clear();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function start(
  source: string,
  kind: "html" | "math" | "image",
  loadMedia = vi.fn(async (_src: string) => "blob:image"),
) {
  const target = document.createElement("div");
  document.body.append(target);
  const view = new EditorView(target, {
    state: EditorState.create({
      doc: parseMarkdown(`# Title\n\n${source}`),
      plugins: [sourceEditingPlugin],
    }),
    nodeViews: {
      ...mathNodeViews,
      ...createHtmlNodeViews(loadMedia),
      ...createImageNodeViews(loadMedia),
    },
  });
  views.add(view);
  const nodeDom = target.querySelector(kind === "image" ? ".note-image" : `.${kind}-block`);
  if (!(nodeDom instanceof HTMLElement)) throw new Error("测试节点未挂载");
  let pos = -1;
  view.state.doc.descendants((node, offset) => {
    if (node.type.name === (kind === "image" ? "image" : `${kind}_block`)) pos = offset;
  });
  return {
    view,
    pos,
    nodeDom,
    loadMedia,
    visible: (visible: boolean) => visibility.get(nodeDom)?.(visible),
    edit: () => {
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
      editSelectedSource(view.state, view.dispatch);
    },
    destroy: () => {
      view.destroy();
      views.delete(view);
    },
  };
}

describe("源码节点的预览生命周期", () => {
  it("图片打开时加载，滚动保留预览，修改来源时释放过期资源", async () => {
    const pending = deferred<string>();
    const load = vi.fn(async (src: string) =>
      src === "first.png" ? pending.promise : "blob:second",
    );
    const editor = start("![图片](first.png)", "image", load);
    editor.visible(true);
    editor.visible(true);
    expect(load).toHaveBeenCalledTimes(1);
    editor.view.dispatch(editor.view.state.tr.setNodeAttribute(editor.pos, "src", "second.png"));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(editor.nodeDom.getAttribute("src")).toBe("blob:second");
    pending.resolve("blob:first");
    await vi.waitFor(() => expect(revokeUrl).toHaveBeenCalledWith("blob:first"));
    editor.visible(true);
    expect(load).toHaveBeenCalledTimes(2);
    editor.visible(false);
    expect(revokeUrl).not.toHaveBeenCalledWith("blob:second");
    editor.visible(true);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(editor.nodeDom.getAttribute("src")).toBe("blob:second");
  });

  it.each(["html", "math"] as const)(
    "%s 打开即渲染，滚动不卸载或重排，也不修改文档",
    async (kind) => {
      const source = kind === "html" ? '<div><img src="image.png"></div>' : "$$\nx\n$$";
      const editor = start(source, kind);
      const original = editor.view.state.doc;
      await Promise.resolve();
      const preview = editor.nodeDom.firstChild;
      editor.visible(false);
      editor.visible(true);
      expect(editor.nodeDom.firstChild).toBe(preview);
      expect(observeViewport).not.toHaveBeenCalled();
      expect(revokeUrl).not.toHaveBeenCalled();
      expect(kind === "html" ? editor.loadMedia : renderTex).toHaveBeenCalledTimes(1);
      expect(editor.view.state.doc).toBe(original);
    },
  );

  it.each(["编辑源码", "销毁节点"])(
    "%s 时立即释放已获得的图片，迟到图片也会释放",
    async (action) => {
      const second = deferred<string>();
      const load = vi.fn(async (src: string) =>
        src === "first.png" ? "blob:first" : second.promise,
      );
      const editor = start('<div><img src="first.png"><img src="second.png"></div>', "html", load);
      editor.visible(true);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      if (action === "编辑源码") editor.edit();
      else editor.destroy();

      expect(revokeUrl).toHaveBeenCalledWith("blob:first");
      second.resolve("blob:second");
      await vi.waitFor(() => expect(revokeUrl).toHaveBeenCalledWith("blob:second"));
      expect(revokeUrl).toHaveBeenCalledTimes(2);
    },
  );

  it("已经离开 HTML 预览时不再启动剩余图片的读取", async () => {
    const first = deferred<string>();
    const load = vi.fn(() => first.promise);
    const editor = start('<div><img src="first.png"><img src="second.png"></div>', "html", load);
    editor.visible(true);
    editor.edit();
    first.resolve("blob:first");
    await vi.waitFor(() => expect(revokeUrl).toHaveBeenCalledWith("blob:first"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(editor.nodeDom.querySelector("textarea")).not.toBeNull();
  });

  it("迟到的公式排版不能覆盖正在编辑的源码", async () => {
    const rendered = deferred<HTMLElement>();
    renderTex.mockReturnValueOnce(rendered.promise);
    const editor = start("$$\nx\n$$", "math");
    editor.visible(true);
    editor.edit();
    const field = editor.nodeDom.querySelector("textarea");
    rendered.resolve(document.createElement("span"));
    await Promise.resolve();
    expect(editor.nodeDom.querySelector("textarea")).toBe(field);
  });

  it("旧公式排版不能覆盖更新后的预览", async () => {
    const original = deferred<HTMLElement>();
    renderTex.mockReturnValueOnce(original.promise);
    const editor = start("$$\nx\n$$", "math");
    editor.visible(true);
    const updated = document.createElement("span");
    updated.textContent = "updated";
    renderTex.mockResolvedValueOnce(updated);
    editor.view.dispatch(editor.view.state.tr.setNodeAttribute(editor.pos, "tex", "y"));
    await Promise.resolve();
    expect(editor.nodeDom.firstChild).toBe(updated);
    const doc = editor.view.state.doc;
    original.resolve(document.createElement("div"));
    await Promise.resolve();
    expect(editor.nodeDom.firstChild).toBe(updated);
    expect(editor.view.state.doc).toBe(doc);
  });
});
