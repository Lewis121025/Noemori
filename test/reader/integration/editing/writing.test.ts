/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo } from "prosemirror-history";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { writingCommands, writingPlugins } from "@reader/renderer/engine/editing/writing";
import { insertLink, selectedLink, removeLink } from "@reader/renderer/engine/editing/link-editing";
import { taskItemView } from "@reader/renderer/engine/rendering/task-view";

let view: EditorView;
function start(source = "", position = 1): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const doc = parseMarkdown(source);
  view = new EditorView(host, {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, position),
      plugins: [
        history(),
        ...writingPlugins({ link: vi.fn(), search: vi.fn() }),
        keymap(baseKeymap),
      ],
    }),
    nodeViews: { list_item: taskItemView },
  });
  return view;
}
function type(text: string): void {
  for (const character of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(character));
  }
}
function key(name: string, options: KeyboardEventInit = {}): boolean {
  return !!view.someProp("handleKeyDown", (handler) =>
    handler(view, new KeyboardEvent("keydown", { key: name, ...options })),
  );
}
afterEach(() => {
  view?.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("核心写作操作", () => {
  it("多行文字粘进单元格时保留表格结构，并以兼容 Markdown 的换行保存", () => {
    start("| 甲 | 乙 |\n| --- | --- |\n| A | B |", 3);
    expect(
      view.pasteText("第一行\n第二行", Object.assign(new Event("paste"), { clipboardData: null })),
    ).toBe(true);
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).childCount).toBe(2);
    expect(view.state.selection.$from.parent.type.name).toBe("table_header");
    const saved = serializeMarkdown(view.state.doc);
    expect(saved).toContain("第一行<br>第二行甲");
    expect(parseMarkdown(saved).eq(view.state.doc)).toBe(true);
  });

  it("多段富文本粘进单元格时保留文字格式和软换行", () => {
    start("| 甲 | 乙 |\n| --- | --- |\n| A | B |", 3);
    expect(
      view.pasteHTML(
        "<p><strong>粗体</strong></p><p>另一行<br>继续</p>",
        Object.assign(new Event("paste"), { clipboardData: null }),
      ),
    ).toBe(true);
    expect(view.state.doc.childCount).toBe(1);
    const saved = serializeMarkdown(view.state.doc);
    expect(saved).toContain("**粗体**<br>另一行<br>继续甲");
    expect(parseMarkdown(saved).eq(view.state.doc)).toBe(true);
  });

  it("单元格 Shift+Enter 插入软换行并保持当前单元格，撤销可恢复", () => {
    start("| 甲 | 乙 |\n| --- | --- |\n| A | B |", 3);
    expect(key("Enter", { shiftKey: true })).toBe(true);
    type("下一行");
    expect(view.state.doc.childCount).toBe(1);
    const saved = serializeMarkdown(view.state.doc);
    expect(saved).toContain("<br>下一行甲");
    expect(parseMarkdown(saved).eq(view.state.doc)).toBe(true);
    undo(view.state, view.dispatch);
    expect(view.state.doc.child(0).child(0).textContent).toBe("甲乙");
  });
  it("首格 Shift+Tab 允许键盘离开编辑区，Mod+Enter 返回后续正文", () => {
    start("| 甲 | 乙 |\n| --- | --- |\n| A | B |\n\n后文", 3);
    expect(key("Tab", { shiftKey: true })).toBe(false);
    expect(key("Enter", { ctrlKey: true })).toBe(true);
    expect(view.state.selection.$from.parent.textContent).toBe("后文");
    expect(view.state.doc.childCount).toBe(2);
  });

  it("中文组词时 Enter 不触发表格导航", () => {
    start("| 甲 | 乙 |\n| --- | --- |\n| A | B |", 3);
    const selection = view.state.selection;
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
    );
    expect(view.state.selection.eq(selection)).toBe(true);
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });

  it("表格内 Enter 不拆单元格，Tab 切换单元格并在末尾增加一行", () => {
    start("| 甲 | 乙 |\n| --- | --- |\n| A | B |", 3);
    expect(key("Enter")).toBe(true);
    expect(view.state.doc.child(0).child(0).childCount).toBe(2);
    expect(view.state.selection.$from.parent.textContent).toBe("A");
    expect(key("Tab")).toBe(true);
    expect(view.state.selection.$from.parent.textContent).toBe("B");
    expect(key("Tab")).toBe(true);
    expect(view.state.doc.child(0).childCount).toBe(3);
    expect(view.state.selection.$from.parent.type.name).toBe("table_cell");
    expect(key("Tab", { shiftKey: true })).toBe(true);
    expect(view.state.selection.$from.parent.textContent).toBe("B");
    expect(parseMarkdown(serializeMarkdown(view.state.doc)).eq(view.state.doc)).toBe(true);
  });

  it.each([
    ["第一段\n\n第二段", 1],
    ["- 第一项\n- 第二项", 3],
    ["```\n代码\n```", 1],
  ] as const)("任务列表的能力查询不构造文档事务，结果与执行一致：%s", (source, position) => {
    start(source, position);
    const state = view.state;
    const transaction = vi.spyOn(state, "tr", "get");
    const available = writingCommands.taskList(state);
    expect(transaction.mock.calls.length).toBe(0);
    expect(writingCommands.taskList(state, view.dispatch)).toBe(available);
  });

  it.each([
    ["# ", "heading"],
    ["> ", "blockquote"],
    ["- ", "bullet_list"],
    ["3. ", "ordered_list"],
  ])("输入 %s 后建立结构，退格可撤销转换", (prefix, name) => {
    start();
    type(prefix);
    expect(view.state.doc.firstChild?.type.name).toBe(name);
    expect(key("Backspace")).toBe(true);
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(view.state.doc.textContent).toBe(prefix);
  });

  it("格式化保留选区文字，保存可重读，撤销恢复原文", () => {
    start("重点内容\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    writingCommands.bold(view.state, view.dispatch);
    const saved = serializeMarkdown(view.state.doc);
    expect(saved).toBe("**重点**内容\n");
    expect(parseMarkdown(saved).eq(view.state.doc)).toBe(true);
    undo(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe("重点内容\n");
  });

  it.each([
    ["bold", "strong", "**重点**内容"],
    ["italic", "em", "*重点*内容"],
    ["strike", "strike", "~~重点~~内容"],
    ["code", "code", "`重点`内容"],
  ] as const)("%s 对混合格式一次统一应用，再次取消，撤销恢复原选区", (name, mark, source) => {
    start(source);
    const original = view.state.doc;
    const selection = TextSelection.create(original, 1, 5);
    view.dispatch(view.state.tr.setSelection(selection));
    writingCommands[name](view.state, view.dispatch);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(view.state.doc.firstChild?.childCount).toBe(1);
    expect(view.state.doc.firstChild?.firstChild?.marks.map((item) => item.type.name)).toEqual([
      mark,
    ]);
    expect(parseMarkdown(serializeMarkdown(view.state.doc)).eq(view.state.doc)).toBe(true);
    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(original)).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
    writingCommands[name](view.state, view.dispatch);
    writingCommands[name](view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe("重点内容\n");
  });

  it("列表 Enter 产生下一项，Tab 缩进与 Shift+Tab 恢复层级", () => {
    start();
    type("- 第一项");
    key("Enter");
    type("第二项");
    expect(view.state.doc.firstChild?.childCount).toBe(2);
    expect(key("Tab")).toBe(true);
    expect(view.state.doc.firstChild?.firstChild?.lastChild?.type.name).toBe("bullet_list");
    expect(key("Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.firstChild?.childCount).toBe(2);
  });

  it("任务输入、点击勾选、撤销和新任务默认未完成共用文档事务", () => {
    start();
    type("- [ ] 第一项");
    const checkbox = view.dom.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    checkbox.click();
    expect(serializeMarkdown(view.state.doc)).toContain("- [x] 第一项");
    undo(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toContain("- [ ] 第一项");
    checkbox.click();
    key("Enter");
    type("第二项");
    expect(serializeMarkdown(view.state.doc)).toContain("- [ ] 第二项");
  });

  it("空列表项 Enter 退出列表，代码块里的 Markdown 保持字面量", () => {
    start();
    type("- 第一项");
    key("Enter");
    key("Enter");
    expect(view.state.doc.lastChild?.type.name).toBe("paragraph");
    type("```ts");
    key("Enter");
    type("# 不转换");
    expect(view.state.doc.lastChild?.type.name).toBe("code_block");
    expect(view.state.doc.lastChild?.attrs.params).toBe("ts");
    expect(view.state.doc.lastChild?.textContent).toBe("# 不转换");
  });

  it("列表首段不能直接转成代码块时，保留围栏文字", () => {
    start();
    type("- ```ts");
    key("Enter");
    expect(view.state.doc.textContent).toContain("```ts");
  });

  it("插入链接保留选区格式，内部链接别名与外链都能保存", () => {
    start("**参考**\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    expect(insertLink("https://example.com", "参考", "md")(view.state, view.dispatch)).toBe(true);
    expect(serializeMarkdown(view.state.doc)).toContain("[**参考**](https://example.com/)");
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    expect(insertLink("目录/知识.md", "知识", "wiki")(view.state, view.dispatch)).toBe(true);
    expect(serializeMarkdown(view.state.doc)).toContain("[[目录/知识.md|知识]]");
  });

  it("代码块不接受链接操作，危险协议不会插入文档", () => {
    start("```\ncode\n```\n");
    expect(insertLink("https://example.com", "x", "md")(view.state, view.dispatch)).toBe(false);
    expect(() => insertLink("javascript:alert(1)", "x", "md")).toThrow();
  });

  it("光标处编辑完整链接，移除链接保留文字与加粗", () => {
    start("前文 [**参考**资料](https://example.com/) 后文\n", 5);
    const link = selectedLink(view.state)!;
    expect(link.label).toBe("参考资料");
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, link.from, link.to)),
    );
    insertLink("https://example.org/", link.label, "md")(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toContain("[**参考**资料](https://example.org/)");
    removeLink(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe("前文 **参考**资料 后文\n");
  });

  it("多段文字建立任务列表，列表类型切换和引用取消不丢内容", () => {
    start("第一段\n\n第二段\n");
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1),
      ),
    );
    writingCommands.taskList(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe("- [ ] 第一段\n- [ ] 第二段\n");
    writingCommands.orderedList(view.state, view.dispatch);
    expect(view.state.doc.firstChild?.type.name).toBe("ordered_list");
    writingCommands.orderedList(view.state, view.dispatch);
    expect(view.state.doc.childCount).toBe(2);
    writingCommands.quote(view.state, view.dispatch);
    expect(view.state.doc.firstChild?.type.name).toBe("blockquote");
    writingCommands.quote(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe("第一段\n\n第二段\n");
  });

  it("取消列表外的引用时保留列表层级", () => {
    start("> - 第一项\n> - 第二项\n", 4);
    writingCommands.quote(view.state, view.dispatch);
    expect(view.state.doc.firstChild?.type.name).toBe("bullet_list");
    expect(view.state.doc.firstChild?.childCount).toBe(2);
  });
});
