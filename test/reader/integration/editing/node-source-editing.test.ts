/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { createHtmlNodeViews } from "@reader/renderer/engine/rendering/html-view";
import { mathNodeViews } from "@reader/renderer/engine/rendering/math-view";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { editSelectedSource, sourceEditingPlugin } from "@reader/renderer/engine/editing/source-editing";

vi.mock("@reader/renderer/engine/rendering/viewport", () => ({
  observeViewport: () => () => {},
  mathPlaceholderText: (tex: string) => tex,
}));

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("源码节点编辑与保存", () => {
  it("选中公式只高亮预览，不抢走正文焦点或进入源码", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const view = new EditorView(target, {
      state: EditorState.create({
        doc: parseMarkdown("正文 $x$ 后文\n"),
        plugins: [sourceEditingPlugin],
      }),
      nodeViews: mathNodeViews,
    });
    views.push(view);
    view.focus();
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 4)));
    await Promise.resolve();
    expect(target.querySelector(".math-source")).toBeNull();
    expect(target.querySelector(".math-inline.ProseMirror-selectednode")).not.toBeNull();
    expect(document.activeElement).toBe(view.dom);
    expect(serializeMarkdown(view.state.doc)).toBe("正文 $x$ 后文\n");
  });

  it.each([
    ["行内公式", "$x$\n", ".math-source", "math_inline", "x + y", "$x + y$"],
    ["块级公式", "$$\nx\n$$\n", ".math-source", "math_block", "x + y", "x + y"],
    [
      "行内 HTML",
      'Text <a id="old"></a>.\n',
      ".html-source",
      "html_inline",
      '<a id="new"></a>',
      '<a id="new"></a>',
    ],
    [
      "块级 HTML",
      "<div>old</div>\n",
      ".html-source",
      "html_block",
      "<div>new</div>",
      "<div>new</div>",
    ],
  ])("%s 未退出编辑时也保存最新输入", async (_name, source, selector, type, edited, expected) => {
    const target = document.createElement("div");
    document.body.append(target);
    const saved: string[] = [];
    const view = new EditorView(target, {
      state: EditorState.create({
        doc: parseMarkdown(`# Title\n\n${source}`),
        plugins: [sourceEditingPlugin],
      }),
      nodeViews: { ...mathNodeViews, ...createHtmlNodeViews(async () => null) },
      handleKeyDown: (current, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "s") {
          saved.push(serializeMarkdown(current.state.doc));
          return true;
        }
        return false;
      },
    });
    views.push(view);
    let pos = -1;
    view.state.doc.descendants((node, offset) => {
      if (node.type.name === type) pos = offset;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    editSelectedSource(view.state, view.dispatch);
    await Promise.resolve();
    const field = target.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    field.value = edited;
    field.setSelectionRange(1, 1);
    field.dispatchEvent(new Event("input", { bubbles: true }));

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(1);
    expect(serializeMarkdown(view.state.doc)).toContain(expected);
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain(expected);
    expect(target.querySelector(selector)).toBe(field);
  });
});
