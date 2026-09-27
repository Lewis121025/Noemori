import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { createMarkdownSession } from "@reader/renderer/engine/markdown/source-session";
import { verifySearchSnapshot } from "@reader/renderer/engine/search/locate";

describe("搜索范围定位", () => {
  it.each([
    ["预算审批\n\n第二处预算**审批**", "预算**审批", "预算审批"],
    ["预算**审批**\n\n预算审批", "预算审批", "预算审批"],
    ["\uFEFF# 标题\r\n\r\nemoji 😀 与 &amp;", "&amp;", "&"],
    ["```token\r\nconst token = 1;\r\n```", "token =", "token ="],
    ["before `token` after", "token", "token"],
    ["before `one\ntwo` after", "two", "two"],
    ["> ```js\n> first\n> token\n> ```", "token", "token"],
    ["first Topic\n\n[[Topic]]", "[[Topic]]", ""],
  ])("源码范围映射到具体出现位置：%s", (source, needle, expected) => {
    const session = createMarkdownSession(source);
    const start = source.lastIndexOf(needle);
    const range = session.rangeAt(start, start + needle.length, 0);
    expect(range).not.toBeNull();
    if (range === null) throw new Error("缺少精确映射");
    expect(session.doc.textBetween(range.from, range.to)).toBe(expected);
    if (source.includes("第二处")) expect(range.from).toBeGreaterThan(6);
    if (source.includes("[[Topic]]"))
      expect(session.doc.nodeAt(range.from)?.type.name).toBe("wiki_link");
  });

  it("编辑后拒绝旧范围，即使导航映射能平移也不套用旧搜索", () => {
    const session = createMarkdownSession("token");
    const state = EditorState.create({ doc: session.doc });
    session.track(state.tr.insertText("new ", 1));
    expect(() => session.rangeAt(0, 5, 0)).toThrow("过期");
  });

  it("不存在可验证映射时返回 null，不退到段落开头", () => {
    const session = createMarkdownSession("# token");
    expect(session.rangeAt(0, 1, 0)).toBeNull();
  });

  it("用原始字节核对版本与 UTF-8 边界，拒绝过期或切断字符的结果", async () => {
    const bytes = new TextEncoder().encode("\uFEFF预算\r\n");
    const snapshot = { bytes, revision: 0 };
    const hash = createHash("sha256").update(bytes).digest("hex");
    const location = { startByte: 3, endByte: 9, line: 1 };
    await expect(verifySearchSnapshot(snapshot, hash, location)).resolves.toBeUndefined();
    await expect(verifySearchSnapshot(snapshot, "0".repeat(64), location)).rejects.toThrow(
      "已变化",
    );
    await expect(
      verifySearchSnapshot(snapshot, hash, { ...location, startByte: 4 }),
    ).rejects.toThrow("范围");
    await expect(
      verifySearchSnapshot(snapshot, hash, { ...location, endByte: 100 }),
    ).rejects.toThrow("范围");
  });
});
