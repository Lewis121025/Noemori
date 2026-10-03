import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { closeHistory, history, undo, redo } from "prosemirror-history";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { documentSchema } from "@reader/shared/markdown/schema";

function edit(source: string, needle: string, replacement: string): string {
  const session = createMarkdownSession(source);
  const state = EditorState.create({ doc: session.doc });
  let position: number | undefined;
  state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(needle)) position = pos + node.text.indexOf(needle);
  });
  if (position === undefined) throw new Error("测试编辑目标不存在");
  const next = state.apply(state.tr.insertText(replacement, position, position + needle.length));
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(session.snapshot(next.doc).bytes);
}

describe("局部编辑的源码契约", () => {
  it.each([
    "\uFEFF# 标题\r\n\r\n> 首行 &amp;\r\n> 第二行定位 🌱\r\n",
    "正文 **加粗定位** 和 [链接](note.md)\n",
    "- 第一项\n  - 嵌套定位\n",
    "```ts\r\nconst 变量 = '定位';\r\n```\r\n",
    "正文 `代码定位` 结尾\n",
  ])("排版位置与源码位置往返保留实际字符：%j", (source) => {
    const session = createMarkdownSession(source);
    const offset = source.indexOf("定位");
    const position = session.positionAt(offset);
    expect(session.doc.textBetween(position, position + 2)).toBe("定位");
    expect(session.sourceOffsetAt(position)).toBe(offset);
  });

  it("逆向位置只属于最新保真快照，不能把新编辑映射到旧源码", () => {
    const session = createMarkdownSession("原文\n\n定位");
    const state = EditorState.create({ doc: session.doc });
    const transaction = state.tr.insertText("新增", 1);
    session.track(transaction);
    expect(() => session.sourceOffsetAt(7)).toThrow("快照");
    const snapshot = session.snapshot(transaction.doc);
    const source = new TextDecoder().decode(snapshot.bytes);
    const offset = source.indexOf("定位");
    expect(session.sourceOffsetAt(session.positionAt(offset))).toBe(offset);
    expect(session.snapshot(transaction.doc)).toEqual(snapshot);
  });

  it.each(["```ts\nconst value = 1;\n```", "- 第一项\n- 第二项"])(
    "带 BOM 的首段转换成多行结构时不复制 BOM：%s",
    (replacement) => {
      const source = "\uFEFF原首段\r\n\r\n尾文 _保留_";
      const session = createMarkdownSession(source);
      const state = EditorState.create({ doc: session.doc });
      const transaction = state.tr.replaceWith(
        0,
        state.doc.child(0).nodeSize,
        parseMarkdown(replacement).content,
      );
      session.track(transaction);
      const saved = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        session.snapshot(transaction.doc).bytes,
      );
      expect(saved).toBe("\uFEFF" + replacement.replace(/\n/g, "\r\n") + "\r\n\r\n尾文 _保留_");
    },
  );
  it("CRLF 文件的 frontmatter 外科编辑不产生双重 \\r，字节保真", () => {
    const source =
      "---\r\nstatus: draft # 进行中\r\nauthor:\r\n  name: 张三\r\n---\r\n\r\n# 标题\r\n\r\n正文。\r\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    // 模拟属性面板：整块替换 frontmatter 源码保留块（混合形态：围栏联接 \n、内部行 \r\n、末内容行不带 \r）。
    const edited = "---\nstatus: done # 进行中\r\nauthor:\r\n  name: 张三\r\ndue: 明天\n---";
    const transaction = state.tr.replaceWith(
      0,
      state.doc.child(0).nodeSize,
      documentSchema.node("markdown_block", null, documentSchema.text(edited)),
    );
    session.track(transaction);
    const saved = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      session.snapshot(transaction.doc).bytes,
    );
    expect(saved).toBe(
      "---\r\nstatus: done # 进行中\r\nauthor:\r\n  name: 张三\r\ndue: 明天\r\n---\r\n\r\n# 标题\r\n\r\n正文。\r\n",
    );
  });

  it("事务映射跟随输入、快照重定位并拒绝旧版本位置", () => {
    const source = "中文 👩‍💻 定位\n\n另一段\n";
    const session = createMarkdownSession(source);
    let state = EditorState.create({ doc: session.doc });
    const initial = session.snapshot(state.doc);
    const offset = source.indexOf("定位");
    const originalPosition = session.positionAt(offset, initial.revision);
    const transaction = state.tr.insertText("新增", 1);
    session.track(transaction);
    state = state.apply(transaction);
    expect(session.positionAt(offset, initial.revision)).toBe(originalPosition + 2);
    const saved = session.snapshot(state.doc);
    expect(saved.revision).toBeGreaterThan(initial.revision);
    expect(session.snapshot(state.doc).revision).toBe(saved.revision);
    expect(() => session.positionAt(offset, initial.revision)).toThrow("版本已过期");
    const updatedOffset = new TextDecoder().decode(saved.bytes).indexOf("定位");
    expect(
      state.doc.textBetween(
        session.positionAt(updatedOffset, saved.revision),
        session.positionAt(updatedOffset, saved.revision) + 2,
      ),
    ).toBe("定位");
  });

  it("源码定位跨过字符实体与引用前缀后仍命中实际文本", () => {
    const source = "> 首行 &amp;\n> 第二行定位 🌱\n";
    const session = createMarkdownSession(source);
    const position = session.positionAt(source.indexOf("定位"));
    expect(session.doc.textBetween(position, position + 2)).toBe("定位");
  });
  it.each([
    ["", "", "开头"],
    ["\uFEFF", "", "中文 👩‍💻"],
    ["保留 _强调_ 的空格。\n", "强调", "新的强调"],
    ["> 保留 _强调_\n>\n> 修改这里\n", "修改这里", "修改以后"],
    ["首行\r\n仍在同一段\r\n", "仍在同一段", "新的中文"],
    ["## 标题 ##\n\n正文\n", "标题", "新标题"],
    ["~~~ts title=demo\nconst a = 1\n~~~~~\n\n原文", "const a = 1", "const a = 2"],
    ["前文 _强调_，修改后文", "修改后文", "* 普通文字"],
  ])("普通编辑保留邻近语法：%j", (source, needle, replacement) => {
    if (needle === "") {
      const session = createMarkdownSession(source);
      const state = EditorState.create({ doc: session.doc });
      expect(
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          session.snapshot(state.tr.insertText(replacement, 1).doc).bytes,
        ),
      ).toBe(source + replacement);
    } else {
      const result = edit(source, needle, replacement);
      expect(result).toBe(
        source.replace(needle, replacement === "* 普通文字" ? "\\* 普通文字" : replacement),
      );
    }
  });

  it("连续修改同段落两处文字保留中间未编辑的语法", () => {
    const source = "左边 _原样保留_ 和 [链接](<some.md>) 右边\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const next = state.tr
      .insertText("左侧", 1, 3)
      .insertText("右侧", state.doc.content.size - 3, state.doc.content.size - 1);
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      source.replace("左边", "左侧").replace("右边", "右侧"),
    );
  });

  it.each([
    ["保留 &amp; 与 \\* 转义，修改这里。\n", "修改这里", "新内容"],
    ["保留 &#x1F331; 与 _强调_，修改这里。\r\n", "修改这里", "新内容"],
    ["> 首行 &amp;\n> 第二行修改这里\n", "修改这里", "新内容"],
  ])("普通编辑保留同一文本片段中的转义和字符实体：%j", (source, needle, replacement) => {
    expect(edit(source, needle, replacement)).toBe(source.replace(needle, replacement));
  });

  it("给局部文字加粗不会改写同段落的引用与强调", () => {
    const source = "加粗这里，保留 _强调_ 和 [引用](<目标.md>)\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const next = state.tr.addMark(1, 5, state.schema.mark("strong"));
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      source.replace("加粗这里", "**加粗这里**"),
    );
  });

  it("移除一个强调标记不改变其他行内结构", () => {
    const source = "前文 _移除_，保留 [引用](<目标.md>) 和 __粗体__\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const next = state.tr.removeMark(4, 6, state.schema.mark("em"));
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      source.replace("_移除_", "移除"),
    );
  });

  it("就地修改公式源码不重写同段落未编辑的格式", () => {
    const source = "_前文_ $x+y$ [资料](<ref.md>)\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    let at = -1;
    state.doc.descendants((node, pos) => {
      if (node.type.name === "math_inline") at = pos;
    });
    const next = state.tr.setNodeMarkup(at, undefined, { tex: "a+b" });
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      source.replace("$x+y$", "$a+b$"),
    );
  });

  it("公式源码编辑后继续输入，保留就近正文的空格", () => {
    const source = "公式前 $x+y$ 公式后。\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const next = state.tr.setNodeMarkup(5, undefined, { tex: "x+y+z" }).insertText("继续", 6);
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      "公式前 $x+y+z$继续 公式后。\n",
    );
  });

  it("将混合粗体统一加粗后继续输入，合并相邻分隔符且保留其他语法", () => {
    const source = "**继续**写作。\n\n_其他段落_\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const next = state.tr.addMark(1, 6, state.schema.mark("strong")).insertText("后续输入", 6);
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      "**继续写作。后续输入**\n\n_其他段落_\n",
    );
  });
  it("修改正文不规范化其他段落、列表符号、空行和文件结尾", () => {
    const source = "Title\n=====\n\n\n* untouched _emphasis_\n\nchange me\n\n    code";
    expect(edit(source, "change me", "changed")).toBe(source.replace("change me", "changed"));
  });

  it("保留 BOM、CRLF、中文和 emoji 的原始字节", () => {
    const source = "\uFEFF# 中文 🌱\r\n\r\n原来的正文\r\n\r\n* 保留这个列表\r\n";
    expect(edit(source, "原来的正文", "新的正文 👩‍💻")).toBe(
      source.replace("原来的正文", "新的正文 👩‍💻"),
    );
  });

  it("修改嵌套列表的一项不重排未变化的同级项", () => {
    const source = "*  first _style_\n*  change\n   * nested\n*  final\n";
    expect(edit(source, "change", "changed")).toBe(source.replace("change", "changed"));
  });

  it("保留属性注释、引用定义和脚注的原始拼写", () => {
    const source =
      '---\n# 注释\ntitle:  "原始标题"\n---\n\nchange\n\n[ref]: <note.md>  "title"\n\n[^a]:  footnote\n';
    expect(edit(source, "change", "changed")).toBe(source.replace("change", "changed"));
  });

  it("插入段落后保留其前后的原文", () => {
    const source = "Heading\n=======\n\n* untouched\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const paragraph = state.schema.node("paragraph", null, state.schema.text("new"));
    const first = state.doc.firstChild;
    if (first === null) throw new Error("缺少测试标题");
    const next = state.apply(state.tr.insert(first.nodeSize, paragraph));
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      "Heading\n=======\n\nnew\n\n* untouched\n",
    );
  });

  it("同一段落中的普通输入不重写已有强调和链接拼写", () => {
    const source = "保留 _强调_ 和 [链接](<note.md>)，修改这里。\n";
    expect(edit(source, "修改这里", "新内容")).toBe(source.replace("修改这里", "新内容"));
  });

  it("追加包含相同句号的文字时不会被公共后缀吞掉", () => {
    const source = "这些编辑需要保留。\n";
    expect(edit(source, "这些编辑需要保留。", "这些编辑需要保留。继续写下新内容。")).toBe(
      "这些编辑需要保留。继续写下新内容。\n",
    );
  });

  it("插入列表项不重写既有列表项", () => {
    const source = "*  first _style_\n*  last\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const first = state.doc.firstChild?.firstChild;
    if (first === null || first === undefined) throw new Error("缺少测试列表");
    const item = state.schema.node(
      "list_item",
      null,
      state.schema.node("paragraph", null, state.schema.text("new")),
    );
    const next = state.apply(state.tr.insert(1 + first.nodeSize, item));
    const saved = new TextDecoder().decode(session.snapshot(next.doc).bytes);
    expect(saved).toContain("*  first _style_\n");
    expect(saved).toContain("*  last\n");
    expect(saved).toContain("new");
  });

  it("修改表格单元格保留其他行的对齐空格", () => {
    const source =
      "| 标题  | 内容     |\n| :--- | -------: |\n| 保留  | _原文_   |\n| 修改  | change   |\n";
    expect(edit(source, "change", "changed")).toBe(source.replace("change", "changed"));
  });

  it("在单元格中输入竖线仍是单元格内容，不新增列或改变邻列", () => {
    const source = "| 甲 | 乙 |\n| --- | ---: |\n| change | _保留_ |\n";
    expect(edit(source, "change", "a|b")).toBe(source.replace("change", "a\\|b"));
  });

  it("插入表格行保留分隔行、原有单元格空格和其他段落", () => {
    const source = "前文\n\n| 甲    | 乙    |\n| :----- | ----: |\n| 原始  | _内容_ |\n\n后文";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const table = state.doc.child(1);
    const header = table.child(0);
    const row = state.schema.node("table_row", null, [
      state.schema.node("table_cell", { align: "left" }, state.schema.text("新增")),
      state.schema.node("table_cell", { align: "right" }, state.schema.text("一行")),
    ]);
    const next = state.tr.insert(state.doc.child(0).nodeSize + 1 + header.nodeSize, row);
    const saved = new TextDecoder().decode(session.snapshot(next.doc).bytes);
    expect(saved).toContain("| 甲    | 乙    |\n| :----- | ----: |\n");
    expect(saved).toContain("| 原始  | _内容_ |\n\n后文");
    expect(saved).toContain("新增");
  });

  it("重排列表项保留每一项的原始标记与强调拼写", () => {
    const source = "*  first _原文_\n* second __加粗__\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const list = state.doc.child(0);
    const reordered = list.type.create(list.attrs, [list.child(1), list.child(0)]);
    const next = state.tr.replaceWith(0, list.nodeSize, reordered);
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      "* second __加粗__\n*  first _原文_\n",
    );
  });

  it("删除表格最后一行保持文件末尾换行不变", () => {
    const source = "| 甲 |\n| --- |\n| 删除 |";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const table = state.doc.child(0);
    const next = state.tr.delete(1 + table.child(0).nodeSize, 1 + table.content.size);
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe("| 甲 |\n| --- |");
  });

  it("删除有序列表首项只调整必要的起始编号", () => {
    const source = "3)  删除\n4)  保留 _原文_\n5)  最后\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const next = state.tr.delete(1, 1 + state.doc.child(0).child(0).nodeSize);
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      "3)  保留 _原文_\n5)  最后\n",
    );
  });

  it("任务勾选仅改变方括号中的标记", () => {
    const source = "*  [ ] 保留 _原文_\n*  [X] 已完成\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const item = state.doc.firstChild?.firstChild;
    if (item === undefined || item === null) throw new Error("缺少测试任务");
    const next = state.apply(
      state.tr.setNodeMarkup(1, undefined, { ...item.attrs, checked: true }),
    );
    expect(new TextDecoder().decode(session.snapshot(next.doc).bytes)).toBe(
      source.replace("[ ]", "[x]"),
    );
  });

  it("撤销到初始内容恢复完全相同的源码，重做恢复编辑快照", () => {
    const source = "A title\n=======\n\noriginal\n\n\n";
    const session = createMarkdownSession(source);
    let state = EditorState.create({ doc: session.doc, plugins: [history()] });
    state = state.apply(state.tr.insertText("!", 3));
    const changed = session.snapshot(state.doc).bytes;
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(session.snapshot(state.doc).bytes).toEqual(new TextEncoder().encode(source));
    redo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(session.snapshot(state.doc).bytes).toEqual(changed);
  });

  it("跨过保存点撤销格式操作，恢复中间版本的原始语法拼写", () => {
    const source = "左 _保留_ 右\n";
    const session = createMarkdownSession(source);
    let state = EditorState.create({ doc: session.doc, plugins: [history()] });
    state = state.apply(state.tr.insertText("！", state.doc.content.size - 1));
    const before = session.snapshot(state.doc).bytes;
    state = state.apply(
      closeHistory(state.tr.addMark(1, state.doc.content.size - 1, state.schema.mark("strong"))),
    );
    session.snapshot(state.doc);
    undo(state, (transaction) => {
      state = state.apply(transaction);
    });
    expect(session.snapshot(state.doc).bytes).toEqual(before);
  });
});
