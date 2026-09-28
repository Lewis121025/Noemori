import { describe, expect, it } from "vitest";
import { parseSessionDocuments } from "@reader/shared/session";
import {
  captureSourcePoint,
  resolveSourcePoint,
} from "@reader/renderer/document/source-point";
import {
  codeIndexToSourceOffset,
  sourceOffsetToCodeIndex,
} from "@reader/renderer/document/source-offset";
import { ReaderHistory } from "@reader/renderer/navigation/history.svelte";

describe("正文阅读锚点", () => {
  it("历史锚点可结构化克隆并跨重启恢复；改名跟随路径，不丢正文位置", () => {
    const history = new ReaderHistory();
    const position = { source: captureSourcePoint("正文".repeat(100), 50), inset: 12 };
    history.pushStep({ path: "旧名.md", anchor: null, position, scrollTop: 900 });
    history.remapPath("旧名.md", "新名.md");
    const persisted = structuredClone(history.snapshot());
    const restored = new ReaderHistory();
    restored.restore(persisted, () => true);
    expect(restored.peekBack()).toEqual({
      path: "新名.md",
      anchor: null,
      position,
      scrollTop: null,
    });
  });
  it("源码选区往返保留 BOM、混合换行和 emoji 两侧的原文位置", () => {
    const source = "\uFEFF开头\r\n中文 👩‍💻 目标\r末行\n";
    for (const text of ["开头", "中文", "👩‍💻", "目标", "末行"]) {
      const offset = source.indexOf(text);
      expect(codeIndexToSourceOffset(source, sourceOffsetToCodeIndex(source, offset))).toBe(offset);
    }
  });
  it("前文插入或删除后仍找到同一段中文与 emoji", () => {
    const source = "\uFEFF# 开头\r\n\r\n第一段。\r\n\r\n这里是正在阅读的 👩‍💻 内容。\r\n\r\n尾声。";
    const point = captureSourcePoint(source, source.indexOf("正在"));
    for (const next of ["新增段落\r\n\r\n" + source, source.slice(source.indexOf("这里"))]) {
      expect(resolveSourcePoint(next, point)).toBe(next.indexOf("正在"));
    }
  });

  it("重复内容按原位置就近匹配，不跳到第一处", () => {
    const paragraph = "相同的长段落。".repeat(30);
    const source = paragraph + "\n\n" + paragraph;
    const offset = paragraph.length + 100;
    const point = captureSourcePoint(source, offset);
    expect(resolveSourcePoint(source, point)).toBe(offset);
    expect(resolveSourcePoint("新增" + source, point)).toBe(offset + 2);
  });

  it("丢失上下文时夹到正文边界，不切开代理对", () => {
    const point = captureSourcePoint("旧正文".repeat(100), 280);
    expect(resolveSourcePoint("新文🌱", point)).toBe("新文🌱".length);
    const middle = captureSourcePoint("甲🌱乙", 2);
    expect(middle.offset).toBe(1);
    expect(resolveSourcePoint("甲🌱乙", middle)).toBe(1);
  });

  it("会话保留有界锚点；缺失、损坏或空栏数据不影响文档恢复", () => {
    const position = { source: captureSourcePoint("正文".repeat(100), 50), inset: -12.5 };
    const pane = { currentPath: "阅读.md", history: { back: [], forward: [] }, position };
    const parse = (value: unknown) =>
      parseSessionDocuments({ panes: [value], active: 0, split: false }).panes[0];
    expect(parse(pane)).toEqual(pane);
    for (const broken of [
      null,
      { ...position, inset: Infinity },
      { ...position, source: { ...position.source, offset: -1 } },
      { ...position, source: { ...position.source, before: "x".repeat(1000) } },
    ]) {
      expect(parse({ ...pane, position: broken })).toEqual({
        currentPath: "阅读.md",
        history: pane.history,
      });
    }
    expect(parse({ ...pane, currentPath: null })).toEqual({
      currentPath: null,
      history: pane.history,
    });
  });
});
