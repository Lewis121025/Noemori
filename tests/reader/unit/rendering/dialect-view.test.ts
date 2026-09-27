/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView, type NodeViewConstructor } from "prosemirror-view";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import {
  calloutDefaultTitle,
  calloutNodeViews,
  commentNodeViews,
  createCodeBlockViews,
  findFootnoteDefinition,
  footnoteNavigation,
  mermaidFocusPlugin,
} from "@reader/renderer/engine/rendering/dialect-view";

let views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  vi.useRealTimers();
});

function mountEditor(
  source: string,
  nodeViews: Record<string, NodeViewConstructor>,
  plugins = [mermaidFocusPlugin(), footnoteNavigation()],
): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown(source), plugins }),
    nodeViews,
  });
  views.push(view);
  return view;
}

describe("标注视图", () => {
  it("显示标题与折叠开关，`-` 初始收起，折叠不改写文档", () => {
    const view = mountEditor("> [!warning]- 小心\n> 正文\n", calloutNodeViews);
    const callout = view.dom.querySelector<HTMLElement>(".callout")!;
    expect(callout.dataset["callout"]).toBe("warning");
    expect(callout.classList.contains("collapsed")).toBe(true);
    const title = callout.querySelector<HTMLInputElement>(".callout-title")!;
    expect(title.value).toBe("小心");
    const before = view.state.doc;
    callout.querySelector<HTMLButtonElement>(".callout-fold")!.click();
    expect(callout.classList.contains("collapsed")).toBe(false);
    expect(view.state.doc.eq(before)).toBe(true);
  });

  it("编辑标题写回属性；不可折叠的标注隐藏开关并用类型作占位标题", () => {
    const view = mountEditor("> [!tip]\n> 正文\n", calloutNodeViews);
    const callout = view.dom.querySelector<HTMLElement>(".callout")!;
    expect(callout.querySelector<HTMLButtonElement>(".callout-fold")!.hidden).toBe(true);
    const title = callout.querySelector<HTMLInputElement>(".callout-title")!;
    expect(title.placeholder).toBe("Tip");
    title.value = "新标题";
    title.dispatchEvent(new Event("input"));
    expect(view.state.doc.firstChild!.attrs["title"]).toBe("新标题");
    expect(serializeMarkdown(view.state.doc)).toBe("> [!tip] 新标题\n> 正文\n");
    expect(calloutDefaultTitle("WARNING")).toBe("Warning");
  });
});

describe("注释视图", () => {
  it("预览显示带分隔符的原文", () => {
    const view = mountEditor("正文 %%藏%%\n\n%%块%%\n", commentNodeViews);
    expect(view.dom.querySelector(".comment-inline")?.textContent).toBe("%%藏%%");
    expect(view.dom.querySelector(".comment-block")?.textContent).toBe("%%块%%");
  });
});

describe("Mermaid 视图", () => {
  const source = "前文\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```js\nlet a\n```\n";

  it("渲染图表预览，普通代码块保持 pre>code", async () => {
    const render = vi.fn(async (_id: string, code: string) => `<svg data-code="${code}"></svg>`);
    const view = mountEditor(source, createCodeBlockViews(render));
    await vi.waitFor(() =>
      expect(view.dom.querySelector(".mermaid-preview svg")?.getAttribute("data-code")).toBe(
        "graph TD\nA-->B",
      ),
    );
    expect(view.dom.querySelectorAll("pre")).toHaveLength(2);
    expect(view.dom.querySelector(".mermaid-block + pre > code")?.textContent).toBe("let a");
  });

  it("光标进入块内才显示源码；语法错误显示原因", async () => {
    const render = vi.fn(async () => {
      throw new Error("语法不对");
    });
    const view = mountEditor(source, createCodeBlockViews(render));
    const block = view.dom.querySelector<HTMLElement>(".mermaid-block")!;
    expect(block.classList.contains("code-active")).toBe(false);
    // 「前文」段落占 0–4，代码块内容从 5 开始。
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
    expect(block.classList.contains("code-active")).toBe(true);
    await vi.waitFor(() =>
      expect(block.querySelector(".mermaid-error")?.textContent).toContain("语法不对"),
    );
  });

  it("源码变化后防抖重绘", async () => {
    vi.useFakeTimers();
    const render = vi.fn(async (_id: string, code: string) => `<svg>${code}</svg>`);
    const view = mountEditor("```mermaid\nA\n```\n", createCodeBlockViews(render));
    expect(render).toHaveBeenCalledTimes(1);
    // 代码块内容从 1 开始，「A」之后是 2。
    view.dispatch(view.state.tr.insertText("B", 2));
    view.dispatch(view.state.tr.insertText("C", 3));
    expect(render).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith(expect.any(String), "ABC", expect.any(Boolean));
  });
});

describe("脚注跳转", () => {
  it("按标签大小写不敏感找到定义，点击引用把光标移入定义", () => {
    const doc = parseMarkdown("文[^Note]\n\n[^note]: 定义\n");
    const target = findFootnoteDefinition(doc, "NOTE");
    expect(target).not.toBeNull();
    expect(findFootnoteDefinition(doc, "missing")).toBeNull();
    const view = mountEditor("文[^Note]\n\n[^note]: 定义\n", {});
    const ref = view.dom.querySelector<HTMLElement>(".footnote-ref")!;
    const pos = view.posAtDOM(ref, 0);
    view.someProp("handleClickOn", (handle) =>
      handle(view, pos, view.state.doc.nodeAt(pos)!, pos, new MouseEvent("click"), true),
    );
    expect(view.state.selection.$from.parent.textContent).toBe("定义");
  });
});
