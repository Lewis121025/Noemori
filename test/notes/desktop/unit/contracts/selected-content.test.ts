import { expect, it } from "vitest";
import { parseSelectedContent } from "@reader/shared/selected-content";

const selected = {
  id: "selection",
  text: "原文😀\n第二行",
  source: { root: "/notes", path: "资料.md", offset: 2, sourceText: "原文😀\n第二行" },
};

it("选区契约保留原文并复制来源，之后的编辑不能改动已提交的快照", () => {
  const original = structuredClone(selected);
  const snapshot = parseSelectedContent(original);
  expect(snapshot).toEqual(selected);
  original.source.offset = 100;
  expect(snapshot.source?.offset).toBe(2);
  expect(parseSelectedContent({ id: "external", text: "外部文字", source: null }).source).toBeNull();
});

it("带额外属性的数组仍不属于选区或来源对象，不能绕过原有协议边界", () => {
  expect(() => parseSelectedContent(Object.assign([], selected))).toThrow();
  expect(() => parseSelectedContent({ ...selected, source: Object.assign([], selected.source) })).toThrow();
});
