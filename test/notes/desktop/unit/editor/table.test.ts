import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { history, redo, undo } from "prosemirror-history";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { insertTable, moveTableCell, tableCommands } from "@reader/renderer/editor/table/table";
import { documentAccess } from "@reader/renderer/editor/read-only";
import { tableLineBreak } from "@reader/renderer/editor/table/table-input";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const source =
  "\uFEFF前文 _原样_\r\n\r\n| 甲   | 乙     |\r\n| :---- | ----: |\r\n| A    | __B__  |\r\n| C    | D      |\r\n\r\n后文";

function sessionFor(text: string, needle: string) {
  const session = createMarkdownSession(text);
  let state = EditorState.create({ doc: session.doc, plugins: [history()] });
  let position: number | undefined;
  state.doc.descendants((node, at) => {
    if (position === undefined && node.isText && node.textContent.includes(needle))
      position = at + node.textContent.indexOf(needle);
  });
  if (position === undefined) throw new Error("缺少测试位置");
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)));
  const apply = (command: Command) =>
    command(state, (transaction) => {
      session.track(transaction);
      state = state.apply(transaction);
    });
  return {
    state: () => state,
    apply,
    type: (text: string) =>
      apply((current, dispatch) => {
        dispatch?.(current.tr.insertText(text));
        return true;
      }),
    select: (position: number, end = position) =>
      apply((current, dispatch) => {
        dispatch?.(current.tr.setSelection(TextSelection.create(current.doc, position, end)));
        return true;
      }),
    save: () => decoder.decode(session.snapshot(state.doc).bytes),
    verifyRoundTrip() {
      const saved = this.save();
      expect(parseMarkdown(saved.replace(/^\uFEFF/, "")).eq(state.doc)).toBe(true);
      let events = 0;
      while (apply(undo)) events++;
      expect(events).toBeGreaterThan(0);
      expect(this.save()).toBe(text);
      for (let index = 0; index < events; index++) expect(apply(redo)).toBe(true);
      expect(this.save()).toBe(saved);
    },
  };
}

describe("表格编辑与源码保真", () => {
  it.each(["left", "center", "right"] as const)(
    "按指定行列和%s对齐插入，首行为表头，保存重开与一次撤销保持一致",
    (align) => {
      const session = sessionFor("前文 _保留_\n\n后文", "前文");
      const command = insertTable({ rows: 4, columns: 5, align });
      expect(command(session.state())).toBe(true);
      expect(session.save()).toBe("前文 _保留_\n\n后文");
      expect(session.apply(command)).toBe(true);
      const table = session.state().doc.child(1);
      expect(table.type.name).toBe("table");
      expect(table.childCount).toBe(4);
      for (const [index, row] of table.content.content.entries()) {
        expect(row.childCount).toBe(5);
        for (const cell of row.content.content) {
          expect(cell.type.name).toBe(index === 0 ? "table_header" : "table_cell");
          expect(cell.attrs["align"]).toBe(align);
        }
      }
      expect(session.state().selection.$from.parent.type.name).toBe("table_header");
      session.verifyRoundTrip();
      expect(session.apply(undo)).toBe(true);
      expect(session.save()).toBe("前文 _保留_\n\n后文");
      expect(session.apply(undo)).toBe(false);
    },
  );

  it("仅表头的一行一列表格可以保存重开", () => {
    const session = sessionFor("正文", "正文");
    expect(session.apply(insertTable({ rows: 1, columns: 1, align: "left" }))).toBe(true);
    expect(session.state().doc.child(1).childCount).toBe(1);
    session.verifyRoundTrip();
  });

  it.each([
    [0, 3], [21, 3], [1.5, 3], [NaN, 3], [Infinity, 3],
    [3, 0], [3, 13], [3, 1.5], [3, NaN],
  ])("拒绝无效尺寸 %s 行 %s 列", (rows, columns) => {
    expect(() => insertTable({ rows, columns, align: "left" })).toThrow(RangeError);
  });

  it("只读、跨段、代码和已有表格位置不能创建表格", () => {
    const command = insertTable({ rows: 3, columns: 3, align: "center" });
    const locked = EditorState.create({ doc: parseMarkdown("正文"), plugins: [documentAccess(true)] });
    expect(command(locked)).toBe(false);
    const across = sessionFor("前文\n\n后文", "前文");
    across.select(1, across.state().doc.content.size - 1);
    expect(across.apply(command)).toBe(false);
    const code = sessionFor("```\n代码\n```", "代码");
    expect(code.apply(command)).toBe(false);
    const existing = sessionFor(source, "甲");
    expect(existing.apply(command)).toBe(false);
    expect(existing.save()).toBe(source);
  });

  it("移动正文行保留原始字节和格式，选区跟随单元格并可撤销", () => {
    const session = sessionFor(source, "B");
    const at = session.state().selection.from;
    session.select(at + 1, at);
    expect(session.apply(tableCommands.moveRowDown)).toBe(true);
    expect(session.state().selection.$from.parent.textContent).toBe("B");
    expect(session.state().selection.anchor).toBeGreaterThan(session.state().selection.head);
    expect(session.save()).toBe(source.replace("| A    | __B__  |\r\n| C    | D      |", "| C    | D      |\r\n| A    | __B__  |"));
    session.verifyRoundTrip();
  });

  it("移动列连同表头、对齐与内容一起移动，选区跟随原内容", () => {
    const session = sessionFor(source, "B");
    const at = session.state().selection.from;
    session.select(at, at + 1);
    expect(session.apply(tableCommands.moveColumnLeft)).toBe(true);
    expect(session.state().selection.$from.parent.textContent).toBe("B");
    expect(session.state().selection.to - session.state().selection.from).toBe(1);
    expect(session.save()).toBe("\uFEFF前文 _原样_\r\n\r\n| 乙     | 甲   |\r\n| ----: | :---- |\r\n| __B__  | A    |\r\n| D      | C    |\r\n\r\n后文");
    session.verifyRoundTrip();
  });

  it("表头和边界不能越界移动，能力查询不修改内容", () => {
    for (const name of ["moveRowUp", "moveRowDown"] as const) {
      const header = sessionFor(source, "甲");
      expect(header.apply(tableCommands[name])).toBe(false);
      expect(header.save()).toBe(source);
    }
    for (const [needle, name] of [["A", "moveRowUp"], ["C", "moveRowDown"], ["A", "moveColumnLeft"], ["B", "moveColumnRight"]] as const) {
      const session = sessionFor(source, needle);
      expect(tableCommands[name](session.state())).toBe(false);
      expect(session.apply(tableCommands[name])).toBe(false);
      expect(session.save()).toBe(source);
    }
    const session = sessionFor(source, "A");
    expect(tableCommands.moveRowDown(session.state())).toBe(true);
    expect(session.save()).toBe(source);
  });

  it("缺少尾部单元格时移动整列补齐矩形，跨单元格选区不猜测移动目标", () => {
    const session = sessionFor("| 甲 | 乙 |\n| :--- | ---: |\n| _保留_ |", "甲");
    expect(session.apply(tableCommands.moveColumnRight)).toBe(true);
    expect(session.save()).toContain("| 乙 | 甲 |");
    expect(session.save()).toContain("|  | _保留_ |");
    session.verifyRoundTrip();
    const across = sessionFor(source, "A");
    const at = across.state().selection.from;
    across.select(at, at + 3);
    expect(across.apply(tableCommands.moveRowDown)).toBe(false);
    expect(across.apply(tableCommands.moveColumnRight)).toBe(false);
  });

  it("软换行使用 <br> 保存，保留当前单元格的强调写法和其他源码", () => {
    const session = sessionFor(source, "B");
    session.apply(tableLineBreak);
    session.type("新行");
    expect(session.save()).toBe(source.replace("__B__", "__<br>新行B__"));
    session.verifyRoundTrip();
  });

  it("编辑已有软换行后的内容，不改写 <BR /> 的原始拼写", () => {
    const text = "| 甲 | 乙 |\n| --- | --- |\n| A<BR />B | __保留__ |";
    const session = sessionFor(text, "B");
    session.type("新");
    expect(session.save()).toBe(text.replace("<BR />B", "<BR />新B"));
    session.verifyRoundTrip();
  });
  it("带 BOM 的正文中新建表格并连续输入、增加行列后可以逐步保存", () => {
    const session = sessionFor("\uFEFF前文 _原样_\r\n\r\n后文", "前文");
    session.apply(insertTable({ rows: 2, columns: 2, align: "left" }));
    session.save();
    session.type("项目");
    session.apply(moveTableCell("next"));
    session.type("结论");
    session.apply(moveTableCell("down"));
    session.type("待处理");
    session.apply(moveTableCell("previous"));
    session.type("记录");
    session.save();
    session.apply(moveTableCell("down"));
    session.type("下一条");
    session.apply(moveTableCell("next"));
    session.type("未完成");
    session.save();
    session.apply(tableCommands.addColumn);
    session.type("备注");
    session.save();
    session.apply(tableCommands.alignCenter);
    expect(session.save()).toContain("备注");
    session.verifyRoundTrip();
  });
  it("列对齐保留文字选区，撤销仅恢复对齐而保留此前的输入", () => {
    const session = sessionFor(source, "B");
    session.type("新");
    const typed = session.save();
    const at = session.state().selection.from;
    session.select(at - 1, at + 1);
    const selection = session.state().selection;
    session.apply(tableCommands.alignCenter);
    expect(session.state().selection.eq(selection)).toBe(true);
    expect(session.apply(undo)).toBe(true);
    expect(session.save()).toBe(typed);
    expect(session.apply(redo)).toBe(true);
    session.verifyRoundTrip();
  });
  it("在正文后插入表格，不替换选中文字，光标落入首个表头", () => {
    const session = sessionFor("前文 _保留_\n\n后文", "前文");
    expect(session.apply(insertTable({ rows: 2, columns: 2, align: "left" }))).toBe(true);
    expect(session.state().selection.$from.parent.type.name).toBe("table_header");
    expect(session.save()).toContain("前文 _保留_\n\n");
    expect(session.save()).toMatch(/\n\n后文$/);
    session.verifyRoundTrip();
  });

  it("插入行保留原有行、分隔符和文件外部字节", () => {
    const session = sessionFor(source, "A");
    expect(session.apply(tableCommands.addRow)).toBe(true);
    const saved = session.save();
    expect(saved).toContain("| :---- | ----: |\r\n| A    | __B__  |\r\n");
    expect(saved).toContain("| C    | D      |\r\n\r\n后文");
    expect(saved.startsWith("\uFEFF前文 _原样_\r\n\r\n")).toBe(true);
    expect(session.state().selection.$from.parent.type.name).toBe("table_cell");
    session.verifyRoundTrip();
  });

  it("删除当前行不改写剩余单元格", () => {
    const session = sessionFor(source, "A");
    expect(session.apply(tableCommands.deleteRow)).toBe(true);
    expect(session.save()).toBe(source.replace("| A    | __B__  |\r\n", ""));
    session.verifyRoundTrip();
  });

  it("插入列只增加必要的单元格和分隔符，保留原有强调写法", () => {
    const session = sessionFor(source, "A");
    expect(session.apply(tableCommands.addColumn)).toBe(true);
    expect(session.save()).toContain("| A    |  | __B__  |");
    expect(session.save()).toContain("| :---- | --- | ----: |");
    session.verifyRoundTrip();
  });

  it("删除列同时更新表头、正文和分隔符，保留另一列的原始空格", () => {
    const session = sessionFor(source, "A");
    expect(session.apply(tableCommands.deleteColumn)).toBe(true);
    expect(session.save()).toBe(
      "\uFEFF前文 _原样_\r\n\r\n| 乙     |\r\n| ----: |\r\n| __B__  |\r\n| D      |\r\n\r\n后文",
    );
    session.verifyRoundTrip();
  });

  it("列对齐更新整列属性，只修改对齐分隔符中的冒号", () => {
    const session = sessionFor(source, "B");
    expect(session.apply(tableCommands.alignCenter)).toBe(true);
    expect(session.save()).toBe(source.replace("| ----: |", "| :----: |"));
    session.verifyRoundTrip();
  });

  it("表头不能作为普通行删除，最后一列由删除表格操作移除", () => {
    const session = sessionFor("| 名称 |\n| --- |\n| 内容 |", "名称");
    expect(session.apply(tableCommands.deleteRow)).toBe(false);
    expect(session.apply(tableCommands.deleteColumn)).toBe(false);
    expect(session.apply(tableCommands.remove)).toBe(true);
    expect(session.state().doc.firstChild?.type.name).toBe("paragraph");
    expect(session.state().selection.$from.parent.type.name).toBe("paragraph");
    session.verifyRoundTrip();
  });

  it("缺少尾部单元格的 Markdown 在结构编辑时补齐，已有内容原样复用", () => {
    const session = sessionFor("| 甲 | 乙 |\n| --- | --- |\n| _保留_ |", "保留");
    expect(session.apply(tableCommands.addRow)).toBe(true);
    expect(session.save()).toContain("| _保留_ |  |");
    session.verifyRoundTrip();
  });

  it.each([
    ["引用", "> | 甲 | 乙 |\n> | :--- | ---: |\n> | _保留_ | B |"],
    ["列表", "- 条目\n\n  | 甲 | 乙 |\n  | :--- | ---: |\n  | _保留_ | B |"],
    ["列表首块", "- | 甲 | 乙 |\n  | :--- | ---: |\n  | _保留_ | B |"],
    ["省略边框", "甲 | 乙\n:--- | ---:\n_保留_ | B"],
    ["单独表头", "| 甲 | 乙 |\n| :--- | ---: |"],
  ])("%s中的表格增加列并保留原有语法", (_label, text) => {
    const session = sessionFor(text, "甲");
    expect(session.apply(tableCommands.addColumn)).toBe(true);
    const saved = session.save();
    expect(saved).toContain("甲 |  | 乙");
    expect(saved).toContain(":--- | --- | ---:");
    if (text.includes("_保留_")) expect(saved).toContain("_保留_ |  | B");
    session.verifyRoundTrip();
  });

  it("转义竖线和行内代码不会被拆成新的列", () => {
    const text = "| 甲 | 乙 |\n| --- | --- |\n| `a\\|b` | _c\\|d_ |";
    const session = sessionFor(text, "甲");
    expect(session.apply(tableCommands.addColumn)).toBe(true);
    expect(session.save()).toContain("| `a\\|b` |  | _c\\|d_ |");
    session.verifyRoundTrip();
  });

  it("已有空白列保留自身间距，不被新增的空白列抢占", () => {
    const text = "| 甲 |      |  |\n| :------ | --------: | :---: |\n| A |    |    |";
    const session = sessionFor(text, "甲");
    expect(session.apply(tableCommands.addColumn)).toBe(true);
    expect(session.save()).toBe(
      "| 甲 |  |      |  |\n| :------ | --- | --------: | :---: |\n| A |  |    |    |",
    );
    session.verifyRoundTrip();
  });

  it("先修改表头再添加列时，保留被编辑列和其他列的原始分隔符", () => {
    const session = sessionFor(source, "甲");
    session.type("新");
    session.save();
    expect(session.apply(tableCommands.addColumn)).toBe(true);
    expect(session.save()).toContain("| 新甲   |  | 乙     |");
    expect(session.save()).toContain("| :---- | --- | ----: |");
    session.verifyRoundTrip();
  });

  it("先设置对齐再输入内容时，未改动的强调写法不被规范化", () => {
    const session = sessionFor(source, "B");
    expect(session.apply(tableCommands.alignCenter)).toBe(true);
    session.type("新");
    expect(session.save()).toContain("| A    | __新B__  |");
    expect(session.save()).toContain("| :---- | :----: |");
    session.verifyRoundTrip();
  });

  it("表头少于正文列数时补齐表头并保留超出的正文内容", () => {
    const text = "| 甲 | 乙 |\n| --- | --- |\n| A | _保留_ | __额外__ |";
    const session = sessionFor(text, "甲");
    expect(session.apply(tableCommands.addRow)).toBe(true);
    expect(session.save()).toContain("| A | _保留_ | __额外__ |");
    expect(session.state().doc.firstChild?.firstChild?.childCount).toBe(3);
    session.verifyRoundTrip();
  });

  it("删除最后一列时保留其余列的排版", () => {
    const session = sessionFor(source, "B");
    expect(session.apply(tableCommands.deleteColumn)).toBe(true);
    expect(session.save()).toBe(
      "\uFEFF前文 _原样_\r\n\r\n| 甲   |\r\n| :---- |\r\n| A    |\r\n| C    |\r\n\r\n后文",
    );
    session.verifyRoundTrip();
  });

  it("新添空白行不抢占已有空白行的源码", () => {
    const text = "| 甲 | 乙 |\n| --- | --- |\n|       |     |\n|  |   |";
    const session = sessionFor(text, "甲");
    expect(session.apply(tableCommands.addRow)).toBe(true);
    expect(session.save()).toBe("| 甲 | 乙 |\n| --- | --- |\n|  |  |\n|       |     |\n|  |   |");
    session.verifyRoundTrip();
  });

  it("表格位于 BOM 后，混合换行在对齐修改后仍保持原样", () => {
    const text = "\uFEFF| 甲 | 乙 |\r\n| --- | --- |\n| A | B |\r\n| C | D |";
    const session = sessionFor(text, "甲");
    expect(session.apply(tableCommands.alignLeft)).toBe(true);
    expect(session.save()).toBe(text.replace("| --- | --- |", "| :--- | --- |"));
    session.verifyRoundTrip();
  });

  it("表格行尾竖线后的空格不被视为额外列，对齐只改变分隔符", () => {
    const text = "| 甲 | 乙 |  \n| --- | --- |   \n| A | _B_ | \t";
    const session = sessionFor(text, "甲");
    session.apply(tableCommands.alignLeft);
    expect(session.save()).toBe(text.replace("| --- | --- |", "| :--- | --- |"));
    session.apply(tableCommands.addColumn);
    expect(session.save()).toBe("| 甲 |  | 乙 |  \n| :--- | --- | --- |   \n| A |  | _B_ | \t");
    session.verifyRoundTrip();
  });

  it("在列表补入的空首段输入正文时保留后面的表格源码", () => {
    const text = "- | 甲 | 乙 |\n  | :--- | ---: |\n  | _保留_ | B |";
    const session = sessionFor(text, "甲");
    session.select(3);
    session.type("新增正文");
    expect(session.save()).toBe("- 新增正文\n  | 甲 | 乙 |\n  | :--- | ---: |\n  | _保留_ | B |");
    session.verifyRoundTrip();
  });
});
