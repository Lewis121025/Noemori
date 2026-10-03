/** @vitest-environment jsdom */
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { expect, it, vi } from "vitest";
import { markdownPosition } from "@reader/renderer/editor/editor-position";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";

it("不透明长块使用可恢复的源码边界及完整偏移，切换布局后仍停在块中部", async () => {
  const session = createMarkdownSession(
    "> [!note] 长标注\n>\n" +
      Array.from({ length: 24 }, (_, index) => `> 第 ${index} 段正文。`).join("\n>\n"),
  );
  let inside = 0;
  session.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === "第 12 段正文。") inside = pos + 1;
  });
  expect(inside).toBeGreaterThan(0);
  const boundary = session.positionAt(session.sourceOffsetAt(inside));
  expect(boundary).toBeLessThan(inside);
  const scroller = document.createElement("div");
  scroller.className = "main";
  scroller.scrollTop = 1800;
  document.body.append(scroller);
  const view = new EditorView(scroller, { state: EditorState.create({ doc: session.doc }) });
  const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => view.dom,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  let blockTop = -1500;
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 1200, 600));
  vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -1700, 1200, 4000));
  vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: inside, inside: 0 });
  vi.spyOn(view, "coordsAtPos").mockImplementation((position) => ({
    left: 200,
    right: 200,
    top: position === boundary ? blockTop : 108,
    bottom: (position === boundary ? blockTop : 108) + 20,
  }));
  try {
    const api = markdownPosition(view, session);
    const captured = api.capturePosition();
    expect(captured?.reading?.inset).toBe(-1600);
    expect(captured?.reading?.source.offset).toBe(session.sourceOffsetAt(inside));
    if (captured === null) throw new Error("未捕获阅读位置");
    blockTop += 64;
    await api.restorePosition({ ...captured, selection: null }, () => true);
    expect(scroller.scrollTop).toBe(1864);
    expect(view.state.doc.eq(session.doc)).toBe(true);
  } finally {
    view.destroy();
    scroller.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
  }
});
