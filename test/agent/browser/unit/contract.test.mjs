import test from "node:test";
import assert from "node:assert/strict";
import {
  navigationUrl,
  parseAction,
} from "../../../../modules/agent/web-runtime/dist/browser/contract.js";

test("导航拒绝本地协议与 URL 内嵌凭据", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:pass@example.com",
  ])
    assert.throws(() => navigationUrl(url));
  assert.equal(
    navigationUrl("https://example.com/path?q=中文"),
    "https://example.com/path?q=%E4%B8%AD%E6%96%87",
  );
});

test("协议边界拒绝无穷坐标、错误按键类型与超限文本", () => {
  const base = {
    action: "pointer",
    page: "p",
    observation: "o",
    x: 1,
    y: 1,
    button: "left",
    clicks: 1,
  };
  for (const change of [{ x: Infinity }, { y: -1 }, { clicks: 1.5 }, { button: "extra" }])
    assert.throws(() => parseAction({ ...base, ...change }));
  assert.throws(() =>
    parseAction({
      action: "fill",
      page: "p",
      observation: "o",
      ref: "e1",
      text: "x".repeat(65537),
    }),
  );
  assert.throws(() => parseAction(null));
  assert.throws(() =>
    parseAction({
      action: "evaluate",
      page: "p",
      observation: "o",
      ref: "e1",
      code: "process.exit()",
    }),
  );
});

test("文本上限与 Rust JSON Schema 一致，按 Unicode 字符计算", () => {
  const action = {
    action: "fill",
    page: "p",
    observation: "o",
    ref: "e1",
    text: "😀".repeat(65536),
  };
  assert.equal(parseAction(action).text, action.text);
  assert.throws(() => parseAction({ ...action, text: action.text + "文" }));
});

test("字段各自合法但批量总 JSON 超过预算时拒绝整个动作", () => {
  const steps = Array.from({ length: 5 }, () => ({
    action: "fill",
    ref: "e1",
    text: "😀".repeat(65536),
  }));
  assert.throws(
    () => parseAction({ action: "batch", page: "p", observation: "o", steps }),
    /1 MiB/,
  );
});
