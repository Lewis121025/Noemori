import { referenceRange } from "../../../../modules/notes/packages/desktop/src/features/reader/shared/selected-content";
import { expect, it } from "vitest";
import {
  addReference,
  matchesReferenceDraft,
  parseReferences,
  readReferencedInput,
  referencedInput,
  type AgentReference,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/references";

const quote: AgentReference = {
  id: "quote",
  text: "汉字😀\n第二行",
  source: { root: "/vault", path: "资料/原文.md", offset: 2, sourceText: "汉字😀\n第二行" },
};

it("引用作为参考数据进入模型，原文与来源可从历史完整恢复", () => {
  const input = referencedInput("解释这段文字", [quote]);
  expect(readReferencedInput(input)).toEqual({ text: "解释这段文字", references: [quote] });
  expect(referencedInput("纯文字")).toBe("纯文字");
  expect(readReferencedInput("纯文字")).toEqual({ text: "纯文字", references: [] });
  expect(matchesReferenceDraft(input, "解释这段文字", [quote])).toBe(true);
  expect(matchesReferenceDraft(input, "新的草稿", [quote])).toBe(false);
  expect(matchesReferenceDraft(input, "解释这段文字", [])).toBe(false);
});

it("将引用信封作为普通原文发送时，只解码外层，不凭文字内容添加引用", () => {
  const literal = referencedInput("这是一段待解释的信封", [quote]);
  const sent = referencedInput(literal);
  expect(readReferencedInput(sent)).toEqual({ text: literal, references: [] });
  expect(matchesReferenceDraft(sent, literal)).toBe(true);
  expect(readReferencedInput(referencedInput(literal, [quote]))).toEqual({
    text: literal,
    references: [quote],
  });
});

it("引用信封的正文仍须满足完整输入契约，非法信封保留为用户原文", () => {
  const encoded = referencedInput("合法正文", [quote]);
  const boundary = encoded.indexOf("\n") + 1;
  for (const input of ["", " ", "汉".repeat(128 * 1024)]) {
    const literal =
      encoded.slice(0, boundary) + JSON.stringify({ text: input, references: [quote] });
    expect(readReferencedInput(literal)).toEqual({ text: literal, references: [] });
  }
});

it("相同来源和内容不重复添加，预算按序列化后的 Unicode 字节计算", () => {
  const references = [quote];
  expect(addReference(references, { ...quote, id: "second" })).toBe(references);
  expect(() => parseReferences([{ ...quote, text: "😀".repeat(10000) }])).toThrow("32 KiB");
  expect(() => parseReferences([quote, quote])).toThrow("身份重复");
  expect(() =>
    parseReferences([{ ...quote, source: { ...quote.source, path: "../秘密.md" } }]),
  ).toThrow("来源无效");
  expect(() => referencedInput("a".repeat(128 * 1024), [quote])).toThrow("128 KiB");
});

it("源码移动后核对原文，缺失或重复时不盲用旧偏移", () => {
  expect(referenceRange("前文" + quote.text, quote.source!)).toEqual({
    from: 2,
    to: 2 + quote.text.length,
  });
  expect(referenceRange("插入了前文" + quote.text, quote.source!)).toEqual({
    from: 5,
    to: 5 + quote.text.length,
  });
  expect(() => referenceRange("原文已删除", quote.source!)).toThrow("无法唯一定位");
  expect(() => referenceRange(quote.text + "重复" + quote.text, quote.source!)).toThrow(
    "无法唯一定位",
  );
});
