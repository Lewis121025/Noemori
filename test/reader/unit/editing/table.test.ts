import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { history, redo, undo } from "prosemirror-history";
import { createMarkdownSession } from "@reader/renderer/engine/markdown/source-session";
import { parseMarkdown } from "@reader/renderer/engine/markdown/parse";
import { moveTableCell, tableCommands } from "@reader/renderer/engine/editing/table";
import { tableLineBreak } from "@reader/renderer/engine/editing/table-input";

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
    session.apply(tableCommands.insert);
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
    expect(session.apply(tableCommands.insert)).toBe(true);
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
