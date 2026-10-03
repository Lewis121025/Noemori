import { describe, expect, it } from "vitest";
import { parseSearchRequest } from "@reader/renderer/search/query";
import { parseSearchRequestArgument } from "@reader/shared/reader-protocol";

describe("融合入口与严格语法隔离", () => {
  it("元数据值中的引号不改变自然语言召回模式", () => {
    expect(parseSearchRequest('如何避免重复请求 path:"技术 文档"')).toEqual({
      kind: "hybrid",
      text: "如何避免重复请求",
      limit: 100,
      filter: { kind: "path", value: "技术 文档" },
    });
    expect(parseSearchRequest('如何避免重复请求 status:"in progress"')).toEqual({
      kind: "hybrid",
      text: "如何避免重复请求",
      limit: 100,
      filter: { kind: "attr", key: "status", value: "in progress" },
    });
    expect(parseSearchRequest('"重复请求" path:"技术 文档"')).toHaveProperty("expr");
  });
  it("普通文本保留语义上下文并提取硬筛选", () => {
    expect(parseSearchRequest("如何避免重复请求 tag:研究 path:技术")).toEqual({
      kind: "hybrid",
      text: "如何避免重复请求",
      limit: 100,
      filter: {
        kind: "and",
        children: [
          { kind: "tag", value: "研究" },
          { kind: "path", value: "技术" },
        ],
      },
    });
  });
  it.each([
    '"search"',
    "alpha OR beta",
    "-alpha",
    "/needle/",
    "line:(alpha beta)",
    "section:alpha",
    "tag:研究",
  ])("严格语法不改变含义：%s", (text) => {
    expect(parseSearchRequest(text)).toHaveProperty("expr");
  });
  it("拒绝把文字谓词作为融合硬筛选", () => {
    expect(() =>
      parseSearchRequestArgument({
        kind: "hybrid",
        text: "hello",
        limit: 100,
        filter: { kind: "term", value: "world" },
      }),
    ).toThrow();
  });
  it("拒绝混合两种请求契约", () => {
    expect(() =>
      parseSearchRequestArgument({
        kind: "hybrid",
        text: "hello",
        limit: 100,
        filter: { kind: "and", children: [] },
        expr: { kind: "term", value: "world" },
      }),
    ).toThrow();
  });
});
