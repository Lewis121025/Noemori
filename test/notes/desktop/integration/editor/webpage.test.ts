/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, undo, redo } from "prosemirror-history";
import { insertWebPage } from "@reader/renderer/editor/webpage/insert";
import { documentAccess } from "@reader/renderer/editor/read-only";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { createWebPageHost, webPageViewport } from "@reader/renderer/preview/webpage-host";
import { createWebPageNodeViews } from "@reader/renderer/markdown/views/webpage-view";
import { EditorView } from "prosemirror-view";
import type { WebPageApi } from "@reader/shared/webpage";

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: (entries: IntersectionObserverEntry[]) => void) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback([
            {
              target,
              isIntersecting: true,
              intersectionRatio: 1,
              time: 0,
              rootBounds: null,
              boundingClientRect: new DOMRect(),
              intersectionRect: new DOMRect(),
            },
          ]),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("正文中间插入可一次撤销重做，并保留前后原始源码", () => {
  const source = "\uFEFF前文 __保留__\r\n\r\n正文\r\n\r\n后文 _保留_";
  const session = createMarkdownSession(source);
  let state = EditorState.create({ doc: session.doc, plugins: [history()] });
  const dispatch = (tr: Parameters<typeof session.track>[0]) => {
    session.track(tr);
    state = state.apply(tr);
  };
  let position = 0;
  state.doc.descendants((node, pos) => {
    if (node.isText && node.text === "正文") position = pos + 1;
  });
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, position)));
  expect(insertWebPage({ url: "https://example.com", height: 480 })(state, dispatch)).toBe(true);
  const saved = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    session.snapshot(state.doc).bytes,
  );
  expect(saved.startsWith("\uFEFF前文 __保留__\r\n")).toBe(true);
  expect(saved.endsWith("后文 _保留_")).toBe(true);
  expect(saved).toContain('"url":"https://example.com/"');
  expect(undo(state, dispatch)).toBe(true);
  expect(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(session.snapshot(state.doc).bytes),
  ).toBe(source);
  expect(redo(state, dispatch)).toBe(true);
  expect(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(session.snapshot(state.doc).bytes),
  ).toBe(saved);
});

it("只读、代码与表格不会被网页插入破坏", () => {
  for (const [source, readOnly] of [
    ["正文", true],
    ["```js\nx\n```", false],
    ["| A |\n| - |\n| B |", false],
  ] as const) {
    const doc = parseMarkdown(source);
    let pos = 1;
    doc.descendants((node, at) => {
      if (node.isText) pos = at;
    });
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, pos),
      plugins: [documentAccess(readOnly)],
    });
    const dispatch = vi.fn();
    expect(insertWebPage({ url: "https://example.com", height: 480 })(state, dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  }
});

it("模态、隐藏和滚动裁剪从源头决定原生网页可见范围", () => {
  const parent = document.createElement("div");
  const host = document.createElement("div");
  parent.style.overflowY = "auto";
  parent.append(host);
  document.body.append(parent);
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(100, -50, 600, 480));
  vi.spyOn(parent, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 60, 800, 500));
  expect(webPageViewport(host).clip).toEqual({ x: 100, y: 60, width: 600, height: 370 });
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  expect(webPageViewport(host).bounds).toBeNull();
  dialog.remove();
  parent.hidden = true;
  expect(webPageViewport(host).bounds).toBeNull();
});

it("网页节点显示故障且可重试，浏览状态不修改笔记，销毁释放原生视图和订阅", async () => {
  const sync = vi.fn<WebPageApi["sync"]>(async () => {});
  const action = vi.fn<WebPageApi["action"]>(async () => {});
  const stop = vi.fn();
  let changed: Parameters<Parameters<typeof createWebPageHost>[0]["subscribe"]>[0] = () => {};
  const pages = createWebPageHost({
    sync,
    action,
    subscribe: (callback) => {
      changed = callback;
      return stop;
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const doc = parseMarkdown('```webpage\n{"url":"https://example.com/","height":480}\n```');
  const view = new EditorView(host, {
    state: EditorState.create({ doc }),
    nodeViews: createWebPageNodeViews(pages, () => {}),
  });
  try {
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());
    const id = sync.mock.calls[0]?.[0]?.layouts[0]?.id;
    if (typeof id !== "string") throw new Error("网页实例未登记");
    changed({
      id,
      url: "https://example.com/next",
      title: "下一页",
      loading: false,
      error: "离线",
      canBack: true,
      canForward: false,
      focused: false,
    });
    expect(host.textContent).toContain("离线");
    expect(host.textContent).toContain("下一页");
    expect(view.state.doc.eq(doc)).toBe(true);
    host.querySelector<HTMLButtonElement>('[aria-label="重新加载网页"]')?.click();
    expect(action).toHaveBeenCalledWith(id, "reload");
  } finally {
    view.destroy();
  }
  await vi.waitFor(() =>
    expect(sync).toHaveBeenLastCalledWith(
      expect.objectContaining({ layouts: [], removed: [expect.any(String)] }),
    ),
  );
  expect(stop).toHaveBeenCalledOnce();
});
