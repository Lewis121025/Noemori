import test from "node:test";
import assert from "node:assert/strict";
import { parseInput, trimText } from "../../../../modules/agent/web-runtime/dist/contract.js";
const limits = {
  max_chars: 30000,
  max_pages: 6,
  image_edge: 640,
  max_download_bytes: 24 * 1024 * 1024,
};
test("辅助输入与 Unicode 截断保持明确边界", () => {
  assert.equal(
    parseInput({
      operation: "page",
      url: "https://example.com",
      limits,
      timeout_ms: 60000,
      proxy: null,
    }).operation,
    "page",
  );
  assert.throws(
    () => parseInput({ operation: "pdf", url: "https://example.com", limits, timeout_ms: 60000 }),
    /PDF 字节/,
  );
  assert.throws(
    () =>
      parseInput({
        operation: "page",
        url: "https://example.com",
        timeout_ms: 60000,
        limits: { ...limits, max_pages: 0 },
      }),
    /页数/,
  );
  assert.deepEqual(trimText("中文😀尾部", 3), { text: "中文😀", truncated: true });
});

test("搜索辅助操作也必须使用宿主剩余预算", () => {
  const input = {
    operation: "search",
    url: "https://www.bing.com/search?q=fixture",
    limits,
    timeout_ms: 1000,
  };
  assert.equal(parseInput(input).operation, "search");
  for (const timeout_ms of [undefined, 0, -1, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(() => parseInput({ ...input, timeout_ms }), /剩余时间预算/);
  }
});
