/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo } from "prosemirror-history";
import { search, SearchQuery, setSearchState } from "prosemirror-search";
import {
  documentAccess,
  setDocumentReadOnly,
  focusDocument,
} from "@reader/renderer/editor/read-only";
import { replaceSearch } from "@reader/renderer/editor/search/search-replace";
import { parseMarkdown } from "@reader/renderer/markdown/parse";
import {
  captureMarkdownReload,
  prepareMarkdownReload,
} from "@reader/renderer/editor/source/markdown-reload";

let view: EditorView;
afterEach(() => {
  view.destroy();
  document.body.replaceChildren();
});

it("只读表面获得键盘焦点并显示交接选区，保持选区方向与正文不变", () => {
  const host = document.createElement("div");
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown("正文选区"),
      plugins: [documentAccess(true)],
    }),
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5, 3)));
  focusDocument(view);
  expect(document.activeElement).toBe(view.dom);
  expect(document.getSelection()?.toString()).toBe("选区");
  expect(view.state.selection.anchor).toBe(5);
  expect(view.state.selection.head).toBe(3);
  expect(view.state.doc.textContent).toBe("正文选区");
});

it("只读正文外部重载后保留焦点与反向选区", () => {
  const host = document.createElement("div");
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown("原文 目标\n"),
      plugins: [documentAccess(true)],
    }),
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 4)));
  focusDocument(view);
  const previous = captureMarkdownReload(view);
  const doc = parseMarkdown("新增前文\n\n原文 目标\n");
  const reload = prepareMarkdownReload(previous, doc);
  view.destroy();
  view = new EditorView(host, {
    state: EditorState.create({
      doc,
      selection: reload.selection,
      plugins: [documentAccess(true)],
    }),
  });
  const cleanup = reload.restore(view);
  cleanup();
  expect(document.activeElement).toBe(view.dom);
  expect(document.getSelection()?.toString()).toBe("目标");
  expect(view.state.selection.anchor).toBeGreaterThan(view.state.selection.head);
  expect(view.state.doc).toBe(doc);
});

it("只读事务边界拒绝直接写入、替换、撤销和追加写入，同时允许查找与选区", () => {
  const host = document.createElement("div");
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown("正文"),
      plugins: [
        documentAccess(false),
        history(),
        search(),
        new Plugin({
          appendTransaction: (transactions, _old, state) =>
            transactions.some((tr) => tr.getMeta("probe"))
              ? state.tr.insertText("追加改写", 1)
              : null,
        }),
      ],
    }),
    handleScrollToSelection: () => true,
  });
  view.dispatch(view.state.tr.insertText("前缀", 1));
  setDocumentReadOnly(view, true);
  const before = view.state.doc;
  view.dispatch(view.state.tr.insertText("直接改写", 1));
  view.dispatch(
    setSearchState(view.state.tr, new SearchQuery({ search: "正文", replace: "替换" })),
  );
  replaceSearch(true)(view.state, view.dispatch, view);
  undo(view.state, view.dispatch);
  view.dispatch(view.state.tr.setMeta("probe", true));
  expect(view.state.doc.eq(before)).toBe(true);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
  expect(view.state.selection.from).toBe(1);
  expect(view.state.selection.to).toBe(3);
  setDocumentReadOnly(view, false);
  undo(view.state, view.dispatch);
  expect(view.state.doc.textContent).toBe("正文");
});
