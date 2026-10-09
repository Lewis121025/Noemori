import { describe, expect, it, vi } from "vitest";
import {
  AllSelection,
  EditorState,
  NodeSelection,
  TextSelection,
  type Command,
} from "prosemirror-state";
import { history, redo, undo } from "prosemirror-history";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { sameMarkdownContent, serializeMarkdown } from "@reader/shared/markdown/serialize";
import { writingCommands } from "@reader/renderer/editor/writing";
import { documentAccess } from "@reader/renderer/editor/read-only";
import { readBlockFormatting } from "@reader/renderer/editor/block-formatting";

function selected(source: string, first: string, last = first): EditorState {
  const doc = parseMarkdown(source);
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    if (node.textContent.includes(first)) from = pos + node.textContent.indexOf(first);
    if (node.textContent.includes(last)) to = pos + node.textContent.indexOf(last) + last.length;
  });
  if (from < 0 || to < 0) throw new Error("测试选区必须存在于正文中");
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
    plugins: [history()],
  });
}

function apply(state: EditorState, command: Command): EditorState {
  let next = state;
  expect(command(state)).toBe(true);
  expect(
    command(state, (tr) => {
      next = state.apply(tr);
    }),
  ).toBe(true);
  next.doc.check();
  expect(sameMarkdownContent(parseMarkdown(serializeMarkdown(next.doc)), next.doc)).toBe(true);
  return next;
}

function reversible(before: EditorState, after: EditorState): void {
  let restored = after;
  expect(
    undo(after, (tr) => {
      restored = after.apply(tr);
    }),
  ).toBe(true);
  expect(restored.doc.eq(before.doc)).toBe(true);
  expect(restored.selection.eq(before.selection)).toBe(true);
  let repeated = restored;
  expect(
    redo(restored, (tr) => {
      repeated = restored.apply(tr);
    }),
  ).toBe(true);
  expect(repeated.doc.eq(after.doc)).toBe(true);
  expect(repeated.selection.eq(after.selection)).toBe(true);
}

describe("列表与引用的统一操作契约", () => {
  it.each(["bulletList", "orderedList", "taskList"] as const)(
    "%s 拒绝把未选项的编号推进到 Markdown 九位编号上限之外",
    (name) => {
      const state = selected("999999999. 首项\n999999999. 尾项\n", "首项");
      state.doc.check();
      const dispatch = vi.fn();
      expect(writingCommands[name](state)).toBe(false);
      expect(writingCommands[name](state, dispatch)).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("编号上限内的拆分保留未选项最后一个合法编号", () => {
    const state = selected("999999998. 首项\n999999999. 尾项\n", "首项");
    const next = apply(state, writingCommands.bulletList);
    expect(next.doc.lastChild?.attrs["order"]).toBe(999999999);
    reversible(state, next);
  });

  it("连续点击不同结构命令时，每次撤销只恢复上一次操作", () => {
    const initial = selected("甲段\n\n乙段\n", "甲段", "乙段");
    const listed = apply(initial, writingCommands.bulletList);
    const numbered = apply(listed, writingCommands.orderedList);
    let previous = numbered;
    expect(
      undo(numbered, (tr) => {
        previous = numbered.apply(tr);
      }),
    ).toBe(true);
    expect(previous.doc.eq(listed.doc)).toBe(true);
    let restored = previous;
    expect(
      undo(previous, (tr) => {
        restored = previous.apply(tr);
      }),
    ).toBe(true);
    expect(restored.doc.eq(initial.doc)).toBe(true);
  });

  it("列表边界只包含实际选中的项，终点落在下一项开头时不改变下一项", () => {
    const state = selected("- 甲项\n- 乙项\n", "甲项", "乙项");
    const boundary = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, state.selection.from, state.selection.to - 2),
      ),
    );
    const next = apply(boundary, writingCommands.orderedList);
    expect(next.doc.firstChild?.type.name).toBe("ordered_list");
    expect(next.doc.lastChild?.type.name).toBe("bullet_list");
    expect(next.doc.lastChild?.textContent).toBe("乙项");
  });

  it("嵌套列表取消为父项内的段落，格式状态和命令不把取消混同于提升层级", () => {
    const state = selected("- 父项\n  - 子项\n  - [x] 子任务\n- 末项\n", "子项");
    expect(readBlockFormatting(state).list).toBe("bullet");
    const next = apply(state, writingCommands.bulletList);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild?.childCount).toBe(2);
    expect(next.doc.firstChild?.firstChild?.child(1).type.name).toBe("paragraph");
    expect(next.doc.firstChild?.firstChild?.lastChild?.firstChild?.attrs["checked"]).toBe(true);
    reversible(state, next);
  });

  it("只取消引用中的当前段落，保留前后引用及完整反向选区", () => {
    let state = selected("> 前段\n>\n> 当前段\n>\n> 后段\n", "当前段");
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, state.selection.to, state.selection.from),
      ),
    );
    expect(readBlockFormatting(state).quote).toBe(true);
    const next = apply(state, writingCommands.quote);
    expect(next.doc.content.content.map((node) => node.type.name)).toEqual([
      "blockquote",
      "paragraph",
      "blockquote",
    ]);
    expect(next.doc.child(1).textContent).toBe("当前段");
    expect(next.selection.anchor).toBeGreaterThan(next.selection.head);
    expect(readBlockFormatting(next).quote).toBe(false);
    reversible(state, next);
  });

  it.each([
    "- [x] 父项\n  - 子项\n  - [ ] 子任务\n\n  > 项内引用\n  >\n  > 第二引用\n\n- 后项\n\n正文\n",
    "> 外层\n>\n> > 内层\n> >\n> > 内层尾\n>\n> 后段\n\n中间\n\n> 另一引用\n\n尾段\n",
    "# 标题\n\n普通 [链接](https://example.com)\n\n```js\n代码\n```\n\n|甲|乙|\n|--|--|\n|一|二|\n\n> [!note] 提示\n> 标注正文\n\n![图片](foo.png)\n",
  ])(
    "合法嵌套与混合选区的查询和执行一致，操作原子且内容不丢失：%s",
    (source) => {
      const doc = parseMarkdown(source);
      const positions: number[] = [];
      const nodePositions: number[] = [];
      doc.descendants((node, pos) => {
        if (node.isText) positions.push(pos, pos + node.nodeSize);
        if (node.isBlock) nodePositions.push(pos);
      });
      const selections = [
        new AllSelection(doc),
        ...nodePositions.map((pos) => NodeSelection.create(doc, pos)),
      ];
      for (const from of positions)
        for (const to of positions) selections.push(TextSelection.create(doc, from, to));
      for (const selection of selections) {
        const state = EditorState.create({ doc, selection, plugins: [history()] });
        expect(() => readBlockFormatting(state)).not.toThrow();
        for (const command of [
          writingCommands.bulletList,
          writingCommands.orderedList,
          writingCommands.taskList,
          writingCommands.quote,
        ]) {
          let next = state;
          const available = command(state);
          expect(
            command(state, (tr) => {
              next = state.apply(tr);
            }),
          ).toBe(available);
          if (!available) {
            expect(next).toBe(state);
            continue;
          }
          expect(next.doc.textContent).toBe(doc.textContent);
          next.doc.check();
          expect(sameMarkdownContent(parseMarkdown(serializeMarkdown(next.doc)), next.doc)).toBe(
            true,
          );
          reversible(state, next);
        }
      }
    },
    15000,
  );

  it.each(["bulletList", "orderedList", "taskList"] as const)(
    "%s 统一应用后，再次选择取消为普通段落",
    (command) => {
      const state = selected("前文\n\n甲段\n\n乙段\n\n后文\n", "甲段", "乙段");
      const formatted = apply(state, writingCommands[command]);
      const next = apply(formatted, writingCommands[command]);
      expect(serializeMarkdown(next.doc)).toBe(serializeMarkdown(state.doc));
      expect(next.doc.textBetween(next.selection.from, next.selection.to, "\n")).toBe("甲段\n乙段");
    },
  );

  it.each(["bulletList", "orderedList", "taskList"] as const)(
    "只有光标时 %s 只操作当前项，保留相邻项及嵌套任务",
    (command) => {
      let state = selected("- 首项\n- 当前项\n  - [x] 子任务\n- 尾项\n", "当前项");
      state = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, state.selection.from + 1)),
      );
      const next = apply(state, writingCommands[command]);
      const items: { text: string; checked: unknown; list: string }[] = [];
      next.doc.descendants((node, _pos, parent) => {
        if (node.type.name === "list_item")
          items.push({
            text: node.textContent,
            checked: node.attrs["checked"],
            list: parent?.type.name ?? "",
          });
      });
      expect(items.find((item) => item.text === "首项")?.list).toBe("bullet_list");
      expect(items.find((item) => item.text === "尾项")?.list).toBe("bullet_list");
      expect(items.find((item) => item.text === "子任务")?.checked).toBe(true);
      const current = items.find((item) => item.text === "当前项子任务");
      if (command === "bulletList") expect(current).toBeUndefined();
      else expect(current?.list).toBe(command === "orderedList" ? "ordered_list" : "bullet_list");
      expect(next.doc.textBetween(next.selection.from, next.selection.from + 1)).toBe("前");
      reversible(state, next);
    },
  );

  it.each(["bulletList", "orderedList", "taskList"] as const)(
    "%s 处理跨列表与正文的完整选区，保留反向选区及未选内容",
    (command) => {
      let state = selected("- 未选项\n- 选中项\n\n选中段\n\n未选段\n", "选中项", "选中段");
      state = state.apply(
        state.tr.setSelection(
          TextSelection.create(state.doc, state.selection.to, state.selection.from),
        ),
      );
      const next = apply(state, writingCommands[command]);
      const type = command === "orderedList" ? "ordered_list" : "bullet_list";
      next.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const $pos = next.doc.resolve(pos);
        let list: string | null = null;
        for (let depth = $pos.depth; depth > 0; depth--)
          if (["bullet_list", "ordered_list"].includes($pos.node(depth).type.name)) {
            list = $pos.node(depth).type.name;
            break;
          }
        expect(list, node.textContent).toBe(
          node.textContent === "未选段"
            ? null
            : node.textContent === "未选项"
              ? "bullet_list"
              : type,
        );
      });
      expect(next.selection.anchor).toBeGreaterThan(next.selection.head);
      expect(next.doc.textBetween(next.selection.from, next.selection.to, "\n")).toBe(
        "选中项\n选中段",
      );
      reversible(state, next);
    },
  );

  it("取消或切换编号列表中间项时，未选项保留原编号", () => {
    const state = selected("7. 首项\n8. 中项\n9. 尾项\n", "中项");
    for (const command of [writingCommands.orderedList, writingCommands.bulletList]) {
      const next = apply(state, command);
      expect(next.doc.firstChild?.attrs["order"]).toBe(7);
      expect(next.doc.lastChild?.attrs["order"]).toBe(9);
      reversible(state, next);
    }
  });

  it.each(["bulletList", "orderedList", "taskList", "quote"] as const)(
    "%s 查询不创建事务，真实只读权限拒绝写入",
    (name) => {
      const state = selected("正文\n", "正文");
      const transaction = vi.spyOn(state, "tr", "get");
      expect(writingCommands[name](state)).toBe(true);
      expect(transaction).not.toHaveBeenCalled();
      const locked = state.reconfigure({ plugins: [documentAccess(true)] });
      const dispatch = vi.fn();
      expect(writingCommands[name](locked)).toBe(false);
      writingCommands[name](locked, dispatch);
      expect(dispatch).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    },
  );

  it.each(["- 普通项\n- [ ] 未完成\n- [x] 已完成\n", "- [ ] 未完成\n- 普通项\n- [x] 已完成\n"])(
    "混合选区统一应用任务格式，不由第一项决定取消，也不重置完成状态：%s",
    (source) => {
      const first = source.startsWith("- 普通") ? "普通项" : "未完成";
      const state = selected(source, first, "已完成");
      const next = apply(state, writingCommands.taskList);
      const checked: unknown[] = [];
      next.doc.descendants((node) => {
        if (node.type.name === "list_item") checked.push(node.attrs["checked"]);
      });
      expect(checked).toEqual([false, false, true]);
      reversible(state, next);
    },
  );

  it.each([
    ["bulletList", "bullet_list"],
    ["orderedList", "ordered_list"],
  ] as const)("任务列表切换为 %s 时保持条目结构并移除复选框", (command, type) => {
    const state = selected("- [x] 第一项\n- [ ] 第二项\n", "第一项", "第二项");
    const next = apply(state, writingCommands[command]);
    expect(next.doc.firstChild?.type.name).toBe(type);
    expect(next.doc.firstChild?.childCount).toBe(2);
    expect(next.doc.firstChild?.content.content.map((node) => node.attrs["checked"])).toEqual([
      null,
      null,
    ]);
    reversible(state, next);
  });

  it("引用与正文混选时统一应用引用，不增加已有引用层级或改变未选段落", () => {
    const state = selected(
      "> 未选引用\n>\n> 选中引用\n\n选中正文\n\n未选正文\n",
      "选中引用",
      "选中正文",
    );
    const next = apply(state, writingCommands.quote);
    next.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const $pos = next.doc.resolve(pos);
      let quotes = 0;
      for (let depth = 1; depth <= $pos.depth; depth++)
        if ($pos.node(depth).type.name === "blockquote") quotes++;
      expect(quotes, node.textContent).toBe(node.textContent === "未选正文" ? 0 : 1);
    });
    reversible(state, next);
  });
});
