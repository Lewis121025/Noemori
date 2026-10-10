import test from "node:test";
import assert from "node:assert/strict";
import { observationResult } from "../../../../modules/agent/web-runtime/dist/browser/observation-update.js";
import { parseAction } from "../../../../modules/agent/web-runtime/dist/browser/contract.js";

const snapshot = (id, change = {}) => ({
  id,
  page: "page",
  url: "https://example.test/",
  title: "标题",
  text: "正文",
  elements: [{ ref: "e1", frame: "root", description: "按钮" }],
  truncated: false,
  warnings: [],
  viewport: { width: 800, height: 600 },
  ...change,
});

test("增量变化整体替换字段并可还原包含新引用的完整观察", () => {
  const previous = snapshot("before");
  const current = snapshot("after", {
    text: "新正文",
    elements: [{ ref: "e1", frame: "child", description: "新控件" }],
    truncated: true,
    warnings: ["框架截断"],
  });
  const result = observationResult(previous, current, {
    mode: "delta",
    baseline: "before",
  });
  assert.equal(result.observation, undefined);
  assert.equal(result.observation_update.kind, "delta");
  assert.deepEqual(
    {
      ...previous,
      ...result.observation_update.changes,
      id: result.observation_update.id,
    },
    current,
  );
  assert.equal(result.observation_update.truncated, true);
});

test("无变化仍分配新的身份，结果不重复传输正文", () => {
  const result = observationResult(snapshot("before"), snapshot("after"), {
    mode: "delta",
    baseline: "before",
  });
  assert.deepEqual(result, {
    observation_update: {
      kind: "unchanged",
      id: "after",
      target: "page",
      base: "before",
      truncated: false,
      changes: {},
    },
  });
});

test("基线缺失、代次失效、跨目标和基线不匹配都明确回退完整观察", () => {
  for (const [previous, request, reason] of [
    [snapshot("before"), { mode: "delta" }, "missing_baseline"],
    [null, { mode: "delta", baseline: "before" }, "invalidated"],
    [
      snapshot("before", { page: "other" }),
      { mode: "delta", baseline: "before" },
      "invalidated",
    ],
    [
      snapshot("other"),
      { mode: "delta", baseline: "before" },
      "baseline_mismatch",
    ],
  ]) {
    const current = snapshot("after");
    const result = observationResult(previous, current, request);
    assert.deepEqual(result.observation, current);
    assert.equal(result.observation_update.kind, "full");
    assert.equal(result.observation_update.reset_reason, reason);
  }
});

test("默认和显式完整观察保持原结果", () => {
  const current = snapshot("after");
  assert.deepEqual(observationResult(null, current), { observation: current });
  assert.deepEqual(
    observationResult(snapshot("before"), current, {
      mode: "full",
      baseline: "before",
    }),
    { observation: current },
  );
});

test("动作策略与显式观察字段在协议边界验证，不静默丢弃或接受错误模式", () => {
  const observe = {
    action: "observe",
    page: "page",
    mode: "delta",
    baseline: "before",
  };
  assert.deepEqual(parseAction(observe), observe);
  const fill = {
    action: "fill",
    page: "page",
    observation: "before",
    ref: "e1",
    text: "文字",
    observation_mode: "none",
  };
  assert.deepEqual(parseAction(fill), fill);
  for (const value of [
    { ...observe, mode: "none" },
    { ...observe, baseline: "" },
    { ...fill, observation_mode: "invalid" },
    { ...fill, mode: "delta" },
    { action: "read", page: "page", offset: 0, observation_mode: "none" },
  ])
    assert.throws(() => parseAction(value));
});
