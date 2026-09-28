import { expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { createMarkdownSession } from "@reader/renderer/engine/markdown/source-session";
import {
  MarkdownSnapshotError,
  restoreMarkdownRecovery,
} from "@reader/renderer/engine/markdown/session-recovery";

it("无法映射的公式编辑仍提供原始源码与最新文档的恢复快照", () => {
  const source = "\uFEFF前 $x$ 后\r\n\r\n原文 _保留_";
  const session = createMarkdownSession(source);
  const state = EditorState.create({ doc: session.doc });
  let position: number | undefined;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "math_inline") position = pos;
  });
  if (position === undefined) throw new Error("缺少测试公式");
  const transaction = state.tr.setNodeAttribute(position, "tex", "");
  session.track(transaction);
  let failure: unknown;
  try {
    session.snapshot(transaction.doc);
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof MarkdownSnapshotError)) throw new Error("未生成可恢复的映射错误");
  expect(failure.recovery.source).toEqual(new TextEncoder().encode(source));
  expect(failure.recovery.revision).toBe(1);
  const restored = createMarkdownSession(source, failure.recovery.editor);
  expect(restored.doc.eq(transaction.doc)).toBe(true);
  expect(() => restored.positionAt(1)).toThrow("尚未生成有效源码");
  const continued = EditorState.create({ doc: restored.doc }).tr.setNodeAttribute(
    position,
    "tex",
    "y",
  );
  restored.track(continued);
  const saved = restored.snapshot(continued.doc);
  expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(saved.bytes)).toBe(
    source.replace("$x$", "$y$"),
  );
  expect(saved.revision).toBe(2);
  expect(restored.positionAt(source.indexOf("原文"), saved.revision)).toBeGreaterThan(0);
});

it.each([
  { type: "unknown" },
  { type: "heading", attrs: { level: 20 } },
  { type: "math_inline", attrs: { tex: { text: "x" } } },
  { type: "ordered_list", attrs: { order: -1 } },
  {
    type: "paragraph",
    content: [
      {
        type: "text",
        text: "x",
        marks: [{ type: "link", attrs: { href: ["script", "alert(1)"] } }],
      },
    ],
  },
])("恢复文档拒绝未知节点、错误结构或非法属性：%j", (node) => {
  const editor = JSON.stringify({
    format: "nous.prosemirror",
    version: 1,
    revision: 1,
    doc: { type: "doc", content: [node] },
  });
  expect(() => restoreMarkdownRecovery(editor)).toThrow("恢复记录已保留");
});
