import { describe, expect, it } from "vitest";
import type { Node as PmNode } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { documentSchema } from "@reader/renderer/engine/markdown/schema";
import { createMarkdownSession } from "@reader/renderer/engine/markdown/source-session";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** 通过真实保存路径生成字节：未改动的片段必须复用原文。 */
function save(source: string, edit: (doc: PmNode) => PmNode): string {
  const session = createMarkdownSession(source);
  return decode(session.snapshot(edit(session.doc)).bytes);
}

function types(doc: PmNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    out.push(node.type.name);
  });
  return out;
}

describe("未改动的方言文档逐字节保留", () => {
  it.each([
    ["高亮", "前 ==高亮 **加粗**== 后\n"],
    ["行内注释", "正文 %%藏起来%% 继续\n"],
    ["段落注释", "%%\n多行\n注释\n%%\n"],
    ["标注", "> [!warning]- 小心  **标题**\n> 第一行\n> 第二行\n>\n> - 列表\n"],
    ["嵌套标注", "> [!note]\n> > [!tip] 内层\n> > 正文\n"],
    ["脚注", "引用[^a]与[^2]。\n\n[^a]: 第一条\n\n[^2]: 第二条\n    续行\n"],
  ])("%s", (_name, source) => {
    expect(save(source, (doc) => doc)).toBe(source);
  });
});

describe("方言语法映射到文档节点", () => {
  it("高亮是格式，可与其他格式嵌套；不成对或三等号保持字面", () => {
    const doc = parseMarkdown("a ==b **c**== d\n");
    const marked = doc.firstChild!.content.content.filter((node) =>
      node.marks.some((mark) => mark.type.name === "highlight"),
    );
    expect(marked.map((node) => node.text)).toEqual(["b ", "c"]);
    expect(doc.firstChild!.textContent).toBe("a b c d");
    for (const literal of ["a == b\n", "===x===\n", "a ==b\n"]) {
      const plain = parseMarkdown(literal);
      expect(types(plain)).not.toContain("highlight");
      expect(plain.firstChild!.content.content.every((node) => node.marks.length === 0)).toBe(true);
    }
  });

  it("注释：独占一段为块注释，句中为行内注释", () => {
    expect(types(parseMarkdown("%%块%%\n"))).toEqual(["comment_block"]);
    const inline = parseMarkdown("前 %%中%% 后\n");
    expect(types(inline)).toContain("comment_inline");
    const node = inline.firstChild!.child(1);
    expect(node.attrs["source"]).toBe("中");
  });

  it("标注拆出类型、折叠、标题与正文", () => {
    const doc = parseMarkdown("> [!Tip]+ 我的 *标题*\n> 正文\n>\n> 第二段\n");
    const callout = doc.firstChild!;
    expect(callout.type.name).toBe("callout");
    expect(callout.attrs).toEqual({ kind: "Tip", fold: "+", title: "我的 *标题*" });
    expect(callout.content.content.map((node) => node.textContent)).toEqual(["正文", "第二段"]);
    const bare = parseMarkdown("> [!note]\n").firstChild!;
    expect(bare.attrs).toEqual({ kind: "note", fold: "", title: "" });
    expect(bare.childCount).toBe(1);
    // 标记后直接换行：正文在同段下一行。
    const untitled = parseMarkdown("> [!tip]\n> 正文\n").firstChild!;
    expect(untitled.type.name).toBe("callout");
    expect(untitled.attrs["title"]).toBe("");
    expect(untitled.textContent).toBe("正文");
    expect(parseMarkdown("> [note] 普通引用\n").firstChild!.type.name).toBe("blockquote");
  });

  it("脚注引用与定义成为独立节点", () => {
    const doc = parseMarkdown("文[^x]\n\n[^x]: 定义 **粗**\n");
    expect(types(doc)).toEqual(
      expect.arrayContaining(["footnote_ref", "footnote_def", "paragraph"]),
    );
    const definition = doc.child(1);
    expect(definition.attrs["label"]).toBe("x");
    expect(definition.textContent).toBe("定义 粗");
  });
});

describe("方言语法序列化稳定", () => {
  it.each([
    "a ==b **c**== d\n",
    "前 %%中%% 后\n",
    "%%块%%\n",
    "> [!warning]- 标题\n> 正文\n",
    "> [!note]\n>\n> - 列表\n",
    "> [!note] 空正文\n",
    "文[^x]\n\n[^x]: 定义\n",
  ])("%j", (source) => {
    const once = serializeMarkdown(parseMarkdown(source));
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
    expect(parseMarkdown(once).eq(parseMarkdown(source))).toBe(true);
  });
});

describe("编辑方言节点只做局部改写", () => {
  it("在高亮内改字只替换那段文字", () => {
    const source = "保持 **不动**\n\n前 ==旧字== 后\n";
    const saved = save(source, (doc) => {
      const paragraph = doc.child(1);
      const edited = paragraph.type.create(
        null,
        paragraph.content.content.map((node) =>
          node.text === "旧字" ? documentSchema.text("新字", node.marks) : node,
        ),
      );
      return doc.copy(doc.content.replaceChild(1, edited));
    });
    expect(saved).toBe("保持 **不动**\n\n前 ==新字== 后\n");
  });

  it("给文字加高亮写出 == 分隔符，普通文字里的 == 被转义", () => {
    const source = "甲\n";
    const highlighted = save(source, (doc) =>
      doc.copy(
        doc.content.replaceChild(
          0,
          documentSchema.node("paragraph", null, [
            documentSchema.text("甲", [documentSchema.mark("highlight")]),
          ]),
        ),
      ),
    );
    expect(highlighted).toBe("==甲==\n");
    // 选区带尾随空格时，空白移到分隔符外，保存仍能通过往返校验。
    const trailing = save(source, (doc) =>
      doc.copy(
        doc.content.replaceChild(
          0,
          documentSchema.node("paragraph", null, [
            documentSchema.text("甲 ", [documentSchema.mark("highlight")]),
            documentSchema.text("乙"),
          ]),
        ),
      ),
    );
    expect(trailing).toBe("==甲== 乙\n");
    const literal = save(source, (doc) =>
      doc.copy(
        doc.content.replaceChild(
          0,
          documentSchema.node("paragraph", null, [documentSchema.text("a==b==c %%d%%")]),
        ),
      ),
    );
    const reparsed = parseMarkdown(literal);
    expect(reparsed.firstChild!.textContent).toBe("a==b==c %%d%%");
    expect(types(reparsed)).not.toContain("comment_inline");
  });

  it("修改标注正文时整块重写，前后内容与标题不变", () => {
    const source = "前文\n\n> [!info] 标题\n> 旧正文\n\n后文\n";
    const saved = save(source, (doc) => {
      const callout = doc.child(1);
      const edited = callout.type.create(callout.attrs, [
        documentSchema.node("paragraph", null, documentSchema.text("新正文")),
      ]);
      return doc.copy(doc.content.replaceChild(1, edited));
    });
    expect(saved).toBe("前文\n\n> [!info] 标题\n> 新正文\n\n后文\n");
  });

  it("修改标注标题与折叠只改首行", () => {
    const source = "> [!info] 旧标题\n> 正文\n";
    const saved = save(source, (doc) => {
      const callout = doc.firstChild!;
      return doc.copy(
        doc.content.replaceChild(
          0,
          callout.type.create({ ...callout.attrs, title: "新标题", fold: "-" }, callout.content),
        ),
      );
    });
    expect(saved).toBe("> [!info]- 新标题\n> 正文\n");
  });

  it("修改注释与脚注定义只影响各自片段", () => {
    const source = "正文 %%旧%% 尾\n\n文[^1]\n\n[^1]: 旧定义\n";
    const saved = save(source, (doc) => {
      const first = doc.child(0);
      const comment = first.child(1);
      const editedFirst = first.copy(
        first.content.replaceChild(1, comment.type.create({ source: "新" })),
      );
      const definition = doc.child(2);
      const editedDefinition = definition.type.create(definition.attrs, [
        documentSchema.node("paragraph", null, documentSchema.text("新定义")),
      ]);
      return doc.copy(doc.content.replaceChild(0, editedFirst).replaceChild(2, editedDefinition));
    });
    expect(saved).toBe("正文 %%新%% 尾\n\n文[^1]\n\n[^1]: 新定义\n");
  });
});
