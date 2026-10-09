import { describe, expect, it } from "vitest";
import type { Node as PmNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { serializeMarkdown } from "@reader/shared/markdown/serialize";
import { documentSchema as schema } from "@reader/shared/markdown/schema";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";
import { MarkdownSnapshotError } from "@reader/renderer/markdown/session-recovery";

const paragraph = (text = "") =>
  schema.node("paragraph", null, text === "" ? undefined : schema.text(text));
const document = (...children: PmNode[]) => schema.node("doc", null, children);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

describe("Markdown 空白布局的持久化契约", () => {
  it("紧凑列表中新增空子列表时补足段落边界，不能把正文变成标题", () => {
    const source = "- 甲\n  > 乙";
    const session = createMarkdownSession(source);
    let state = EditorState.create({ doc: session.doc });
    const item = state.doc.firstChild!.firstChild!;
    const child = schema.node("bullet_list", null, [schema.node("list_item", null, [paragraph()])]);
    const replacement = item.type.create(item.attrs, [item.firstChild!, child]);
    const tr = state.tr.replaceWith(1, 1 + item.nodeSize, replacement);
    session.track(tr);
    state = state.apply(tr);
    const saved = decode(session.snapshot(state.doc).bytes);
    expect(parseMarkdown(saved).firstChild?.firstChild?.child(1).type.name).toBe("bullet_list");
    expect(parseMarkdown(saved).textContent).toBe("甲");
  });

  it.each([
    ["", document(paragraph())],
    ["\n", document(paragraph(), paragraph())],
    ["\n\n", document(paragraph(), paragraph(), paragraph())],
    ["\n正文\n", document(paragraph(), paragraph("正文"))],
    ["正文\n\n", document(paragraph("正文"), paragraph())],
    ["甲\n\n乙\n", document(paragraph("甲"), paragraph("乙"))],
    ["甲\n\n\n乙\n", document(paragraph("甲"), paragraph(), paragraph("乙"))],
    ["甲\n\n\n\n乙\n", document(paragraph("甲"), paragraph(), paragraph(), paragraph("乙"))],
  ])("空行有确定的段落含义，重新打开后布局不变：%j", (source, expected) => {
    const doc = parseMarkdown(source);
    expect(doc.toJSON()).toEqual(expected.toJSON());
    expect(parseMarkdown(serializeMarkdown(doc)).toJSON()).toEqual(expected.toJSON());
    const session = createMarkdownSession(source);
    expect(decode(session.snapshot(session.doc).bytes)).toBe(source);
  });

  it.each(["", "\uFEFF", "原文\n", "\uFEFF原文\r\n"])(
    "新建或末尾回车可保存，已有源码与换行保持不变：%j",
    (source) => {
      const session = createMarkdownSession(source);
      const state = EditorState.create({ doc: session.doc });
      const transaction = state.tr.split(state.doc.content.size - 1);
      session.track(transaction);
      const saved = decode(session.snapshot(transaction.doc).bytes);
      expect(parseMarkdown(saved.replace(/^\uFEFF/, "")).toJSON()).toEqual(
        transaction.doc.toJSON(),
      );
      expect(saved.startsWith(source)).toBe(true);
      expect(saved).not.toMatch(/<|&nbsp;|\u200b/);
      if (source.includes("\r\n")) expect(saved.replace(/\r\n/g, "")).not.toContain("\n");
    },
  );

  it.each([0, 3, 6])("插入空段落后仍能双向定位正文，插入位置 %i", (at) => {
    const session = createMarkdownSession("甲\n\n乙\n");
    const state = EditorState.create({ doc: session.doc });
    const transaction = state.tr.insert(at, paragraph());
    session.track(transaction);
    const snapshot = session.snapshot(transaction.doc);
    const saved = decode(snapshot.bytes);
    expect(parseMarkdown(saved).toJSON()).toEqual(transaction.doc.toJSON());
    const offset = saved.indexOf("乙");
    const range = session.rangeAt(offset, offset + 1, snapshot.revision);
    expect(range).not.toBeNull();
    if (range === null) throw new Error("空段落后的正文没有源码映射");
    expect(transaction.doc.textBetween(range.from, range.to)).toBe("乙");
    expect(session.sourceOffsetAt(range.from)).toBe(offset);
    transaction.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.content.size === 0) {
        expect(session.positionAt(session.sourceOffsetAt(pos + 1))).toBe(pos + 1);
      }
    });
  });

  it.each(["\n甲\n", "甲\n\n", "甲\n\n\n乙\n"])(
    "在已有空段落内输入不会合并相邻正文：%j",
    (source) => {
      const session = createMarkdownSession(source);
      const state = EditorState.create({ doc: session.doc });
      let at = -1;
      state.doc.descendants((node, pos) => {
        if (node.type.name === "paragraph" && node.content.size === 0) at = pos + 1;
      });
      expect(at).toBeGreaterThanOrEqual(1);
      const transaction = state.tr.insertText("新增", at);
      session.track(transaction);
      const saved = decode(session.snapshot(transaction.doc).bytes);
      expect(parseMarkdown(saved).toJSON()).toEqual(transaction.doc.toJSON());
      expect(saved).toContain("新增");
    },
  );

  it("连续保存与撤销重做不累加空行，未修改语法保持原字节", () => {
    const source = "\uFEFF甲 _原样_\r\n\r\n乙\r\n";
    const session = createMarkdownSession(source);
    let state = EditorState.create({ doc: session.doc, plugins: [history()] });
    const apply = (transaction: typeof state.tr) => {
      session.track(transaction);
      state = state.apply(transaction);
    };
    apply(state.tr.insert(state.doc.child(0).nodeSize, paragraph()));
    const withBlank = session.snapshot(state.doc).bytes;
    expect(decode(withBlank)).toBe(source.replace("\r\n\r\n乙", "\r\n\r\n\r\n乙"));
    expect(session.snapshot(state.doc).bytes).toEqual(withBlank);
    apply(closeHistory(state.tr.insertText("续写", state.doc.content.size - 1)));
    const edited = session.snapshot(state.doc).bytes;
    expect(parseMarkdown(decode(edited).slice(1)).toJSON()).toEqual(state.doc.toJSON());
    expect(undo(state, apply)).toBe(true);
    expect(session.snapshot(state.doc).bytes).toEqual(withBlank);
    expect(undo(state, apply)).toBe(true);
    expect(session.snapshot(state.doc).bytes).toEqual(new TextEncoder().encode(source));
    expect(redo(state, apply)).toBe(true);
    expect(session.snapshot(state.doc).bytes).toEqual(withBlank);
  });

  it.each(["blockquote", "list_item", "footnote_def", "callout"])(
    "%s 内的首尾及中间空段落保持所属容器",
    (kind) => {
      for (const children of [
        [paragraph(), paragraph()],
        [paragraph(), paragraph("甲")],
        [paragraph("甲"), paragraph()],
        [paragraph("甲"), paragraph(), paragraph("乙")],
      ]) {
        const attrs = kind === "footnote_def" ? { label: "n" } : null;
        const container = schema.node(kind, attrs, children);
        const doc = document(
          kind === "list_item" ? schema.node("bullet_list", null, container) : container,
        );
        const session = createMarkdownSession("");
        const saved = decode(session.snapshot(doc).bytes);
        const restored = parseMarkdown(saved);
        expect(serializeMarkdown(restored)).toBe(serializeMarkdown(doc));
        const actual = kind === "list_item" ? restored.child(0).child(0) : restored.child(0);
        expect(actual.content.toJSON()).toEqual(container.content.toJSON());
      }
    },
  );

  it("恢复记录里的两个空段落可以直接生成 Markdown", () => {
    const doc = document(paragraph(), paragraph());
    const recovery = JSON.stringify({
      format: "noemori.prosemirror",
      version: 1,
      revision: 25,
      doc: doc.toJSON(),
    });
    const session = createMarkdownSession("", recovery);
    const saved = session.snapshot(session.doc);
    expect(saved.revision).toBe(25);
    expect(parseMarkdown(decode(saved.bytes)).toJSON()).toEqual(doc.toJSON());
  });

  it.each(["blockquote", "bullet_list", "ordered_list"])(
    "嵌套 %s 和相邻块保持空段所属层级",
    (kind) => {
      const body = [paragraph(), paragraph("甲"), paragraph(), paragraph("乙"), paragraph()];
      const nested = schema.node("blockquote", null, body);
      const container =
        kind === "blockquote"
          ? schema.node(kind, null, [paragraph("前"), nested, paragraph("后")])
          : schema.node(kind, kind === "ordered_list" ? { order: 12 } : null, [
              schema.node("list_item", null, body),
              schema.node("list_item", null, [paragraph("下一项"), nested]),
            ]);
      const doc = document(paragraph("文首"), container, paragraph(), paragraph("文尾"));
      const session = createMarkdownSession("");
      const saved = decode(session.snapshot(doc).bytes);
      const shape = (node: PmNode) =>
        JSON.parse(
          JSON.stringify(node.toJSON(), (key, value: unknown) =>
            key === "spread" ? undefined : value,
          ),
        );
      expect(shape(parseMarkdown(saved))).toEqual(shape(doc));
    },
  );

  it.each(["> 甲\n>\n>\n> 乙\n", "- 甲\n\n\n  乙\n", "[^n]: 甲\n\n\n    乙\n", "甲\n\n\n乙\n"])(
    "删除已有空段落只移除对应空白，并保持正文定位：%j",
    (source) => {
      const session = createMarkdownSession(source);
      const state = EditorState.create({ doc: session.doc });
      let at = -1;
      state.doc.descendants((node, pos) => {
        if (node.type.name === "paragraph" && node.content.size === 0) at = pos;
      });
      expect(at).toBeGreaterThanOrEqual(0);
      const transaction = state.tr.delete(at, at + 2);
      session.track(transaction);
      const snapshot = session.snapshot(transaction.doc);
      const saved = decode(snapshot.bytes);
      expect(serializeMarkdown(parseMarkdown(saved))).toBe(serializeMarkdown(transaction.doc));
      const offset = saved.indexOf("乙");
      const range = session.rangeAt(offset, offset + 1, snapshot.revision);
      expect(range).not.toBeNull();
      if (range !== null) expect(transaction.doc.textBetween(range.from, range.to)).toBe("乙");
    },
  );

  it("同时插入空段和修改正文仍保留原始强调与转义", () => {
    const source = "首段 _原样_\n\n后段 &amp;\n";
    const session = createMarkdownSession(source);
    const state = EditorState.create({ doc: session.doc });
    const transaction = state.tr
      .insert(state.doc.child(0).nodeSize, paragraph())
      .insertText("新", 1);
    session.track(transaction);
    expect(decode(session.snapshot(transaction.doc).bytes)).toBe("新首段 _原样_\n\n\n后段 &amp;\n");
  });

  it("空公式仍拒绝覆盖，空列表项和代码块仍有独立结构", () => {
    const invalid = document(
      schema.node("paragraph", null, schema.node("math_inline", { tex: "" })),
    );
    expect(() => createMarkdownSession("").snapshot(invalid)).toThrow(MarkdownSnapshotError);
    const doc = document(
      schema.node("bullet_list", null, schema.node("list_item", null, paragraph())),
      schema.node("code_block", null, schema.text("\n\n")),
    );
    const session = createMarkdownSession("");
    expect(parseMarkdown(decode(session.snapshot(doc).bytes)).toJSON()).toEqual(doc.toJSON());
  });

  it.each([false, true])("空任务项保留勾选状态并能继续输入：%s", (checked) => {
    const source = checked ? "- [x]\n" : "- [ ]\n";
    const session = createMarkdownSession(source);
    expect(session.doc.child(0).child(0).attrs["checked"]).toBe(checked);
    expect(session.doc.child(0).child(0).child(0).content.size).toBe(0);
    const state = EditorState.create({ doc: session.doc });
    const transaction = state.tr.insertText("任务正文", 3);
    session.track(transaction);
    const saved = decode(session.snapshot(transaction.doc).bytes);
    expect(saved).toBe(source.replace("\n", " 任务正文\n"));
    expect(parseMarkdown(saved).toJSON()).toEqual(transaction.doc.toJSON());
    expect(parseMarkdown("- \\[ ]\n").child(0).child(0).attrs["checked"]).toBeNull();
  });
});
