import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import {
  findMentionPmPos,
  utf8ByteToJsIndex,
} from "@reader/renderer/engine/navigation/mention-jump";

const skipFixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../links/fixtures/unlinked_skip.md"),
  "utf8",
);

describe("findMentionPmPos", () => {
  it("finds the nth wiki_link with the same target", () => {
    const doc = parseMarkdown("See [[T]] then [[T]]");
    const first = findMentionPmPos(doc, { kind: "linked", linkKind: "wiki", toRaw: "T" }, 1);
    const second = findMentionPmPos(doc, { kind: "linked", linkKind: "wiki", toRaw: "T" }, 2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).toBeGreaterThan(first ?? 0);
    expect(doc.nodeAt(second ?? -1)?.type.name).toBe("wiki_link");
  });

  it("finds the nth markdown link with the same href", () => {
    const doc = parseMarkdown("[a](./T.md) and [b](./T.md)");
    const second = findMentionPmPos(doc, { kind: "linked", linkKind: "md", toRaw: "./T.md" }, 2);
    expect(second).not.toBeNull();
    const node = doc.nodeAt(second ?? -1);
    expect(node?.isText).toBe(true);
    expect(node?.text).toBe("b");
    expect(node?.marks.some((mark) => mark.type.name === "link")).toBe(true);
  });

  it("counts a markdown link with inner marks as one occurrence", () => {
    const doc = parseMarkdown("[a **b**](./T.md) then [c](./T.md)");
    const second = findMentionPmPos(doc, { kind: "linked", linkKind: "md", toRaw: "./T.md" }, 2);
    expect(second).not.toBeNull();
    expect(doc.nodeAt(second ?? -1)?.text).toBe("c");
  });

  it("finds unlinked text and skips wiki links", () => {
    const doc = parseMarkdown("[[Topic]] then Topic later");
    const pos = findMentionPmPos(doc, { kind: "unlinked", linkKind: null, toRaw: "Topic" }, 1);
    expect(pos).not.toBeNull();
    const $pos = doc.resolve(pos ?? -1);
    expect($pos.parent.type.name).not.toBe("wiki_link");
    expect($pos.parent.textBetween($pos.parentOffset, $pos.parentOffset + 5)).toBe("Topic");
  });

  it("skips code and math when counting unlinked text", () => {
    const doc = parseMarkdown("`Topic` $Topic$ then Topic later");
    const pos = findMentionPmPos(doc, { kind: "unlinked", linkKind: null, toRaw: "Topic" }, 1);
    expect(pos).not.toBeNull();
    const $pos = doc.resolve(pos ?? -1);
    expect($pos.nodeAfter?.marks.some((mark) => mark.type.name === "code")).toBeFalsy();
    expect($pos.parent.textBetween($pos.parentOffset, $pos.parentOffset + 5)).toBe("Topic");
  });

  it("matches the shared skip fixture: two unlinked Topics after code, math, and wiki", () => {
    const doc = parseMarkdown(skipFixture);
    const first = findMentionPmPos(doc, { kind: "unlinked", linkKind: null, toRaw: "Topic" }, 1);
    const second = findMentionPmPos(doc, { kind: "unlinked", linkKind: null, toRaw: "Topic" }, 2);
    const third = findMentionPmPos(doc, { kind: "unlinked", linkKind: null, toRaw: "Topic" }, 3);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    expect(doc.textBetween(first ?? 0, (first ?? 0) + 5)).toBe("Topic");
    expect(doc.textBetween(second ?? 0, (second ?? 0) + 5)).toBe("Topic");
    expect(second).toBeGreaterThan(first ?? 0);
  });
});

describe("utf8ByteToJsIndex", () => {
  it("BOM 和 emoji 不被解码器吞掉，字节落在字符中间时向前对齐", () => {
    const source = "\uFEFF中👩‍💻é";
    const parts = [
      "",
      "\uFEFF",
      "\uFEFF中",
      "\uFEFF中👩",
      "\uFEFF中👩‍",
      "\uFEFF中👩‍💻",
      "\uFEFF中👩‍💻e",
      source,
    ];
    for (const prefix of parts) {
      const at = new TextEncoder().encode(prefix).length;
      expect(utf8ByteToJsIndex(source, at)).toBe(prefix.length);
    }
    expect(utf8ByteToJsIndex(source, 1)).toBe(0);
    expect(utf8ByteToJsIndex(source, 4)).toBe(1);
    expect(utf8ByteToJsIndex(source, 8)).toBe(2);
  });
  it("counts UTF-8 bytes not UTF-16 units", () => {
    const source = "字T";
    const bytes = new TextEncoder().encode(source);
    const tByte = bytes.length - 1;
    expect(utf8ByteToJsIndex(source, tByte)).toBe(1);
    expect(source.slice(utf8ByteToJsIndex(source, tByte))).toBe("T");
  });
});
