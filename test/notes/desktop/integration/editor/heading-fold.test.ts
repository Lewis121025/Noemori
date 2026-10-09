/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import {
  foldedHeadingRanges,
  headingFolding,
  headingSections,
  toggleHeadingFold,
} from "@reader/renderer/editor/heading-fold";

let view: EditorView;
let host: HTMLDivElement;
afterEach(() => {
  view.destroy();
  host.remove();
});
function start(source = "# 第一章\n\n## 小节\n\n细节\n\n# 第二章\n\n结尾\n") {
  host = document.createElement("div");
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown(source), plugins: [headingFolding()] }),
  });
}
function key(value: string): boolean {
  return !!view.someProp("handleKeyDown", (handler) =>
    handler(view, new KeyboardEvent("keydown", { key: value })),
  );
}

it("折叠按钮保留标题和键盘焦点，正文完整节点仅隐藏", () => {
  start();
  const doc = view.state.doc;
  const button = host.querySelector<HTMLButtonElement>('[aria-label="折叠章节：第一章"]')!;
  button.focus();
  button.click();
  expect(host.querySelector("h1")?.hidden).toBe(false);
  expect(host.querySelector("h1")?.getAttribute("aria-label")).toBe("第一章");
  expect(host.querySelector("h2")?.hidden).toBe(true);
  const next = host.querySelector<HTMLButtonElement>('[aria-label="展开章节：第一章"]')!;
  expect(document.activeElement).toBe(next);
  expect(view.state.doc.eq(doc)).toBe(true);
  next.click();
  expect(host.querySelector("h2")?.hidden).toBe(false);
});

it("嵌套引用折叠只隐藏标题后的子块，不隐藏整个引用与外部正文", () => {
  start("> ## 引用标题\n>\n> 引用正文\n\n外部正文\n");
  host.querySelector<HTMLButtonElement>(".heading-fold-toggle")!.click();
  expect(host.querySelector("blockquote")?.hidden).toBe(false);
  expect(host.querySelector("blockquote p")?.hidden).toBe(true);
  expect(host.querySelector(".ProseMirror > p")?.hidden).toBe(false);
});

it("折叠标题末尾删除与下一章节开头退格先展开，首次按键不改写隐藏正文", () => {
  start();
  const sections = headingSections(view.state.doc);
  const original = view.state.doc;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, sections[0]!.from - 1)),
  );
  toggleHeadingFold(0)(view.state, view.dispatch, view);
  expect(key("Delete")).toBe(true);
  expect(foldedHeadingRanges(view.state)).toHaveLength(0);
  expect(view.state.doc.eq(original)).toBe(true);
  toggleHeadingFold(0)(view.state, view.dispatch, view);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, sections[2]!.pos + 1)),
  );
  expect(key("Backspace")).toBe(true);
  expect(foldedHeadingRanges(view.state)).toHaveLength(0);
  expect(view.state.doc.eq(original)).toBe(true);
});

it("折叠标题内回车先展开，再把插入交给正常编辑命令", () => {
  start();
  toggleHeadingFold(0)(view.state, view.dispatch, view);
  expect(key("Enter")).toBe(false);
  expect(foldedHeadingRanges(view.state)).toHaveLength(0);
});
