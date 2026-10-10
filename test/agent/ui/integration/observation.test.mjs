import test from "node:test";
import assert from "node:assert/strict";
import { fixture, ref } from "../support/browser.mjs";
import {
  exerciseSemanticObservation,
  exerciseWebMcpObservation,
} from "../support/observation-lifecycle.mjs";

function restore(previous, result) {
  const update = result.observation_update;
  assert.equal(update.base, previous.id);
  return { ...previous, ...update.changes, id: update.id };
}
function countCaptures(f) {
  let count = 0;
  const send = f.transport.send.bind(f.transport);
  f.transport.send = (session, method, values) => {
    if (
      method === "Runtime.evaluate" &&
      values?.expression?.includes("function observeDom(")
    )
      count++;
    return send(session, method, values);
  };
  return () => count;
}

test("extension 增量可还原新引用，无变化仍拒绝旧观察", async (t) => {
  const f = await fixture(t, "<label>姓名<input></label><button>保存</button>");
  const first = await f.observe();
  const unchanged = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: first.observation.id,
  });
  assert.equal(unchanged.observation, undefined);
  assert.equal(unchanged.observation_update.kind, "unchanged");
  const current = restore(first.observation, unchanged);
  const stale = await f.run({
    action: "click",
    ...ref(first.observation, "保存"),
  });
  assert.equal(stale.outcome, "not_executed");
  const full = await f.observe();
  const changed = await f.run({
    action: "fill",
    ...ref(full.observation, 'input "姓名"'),
    text: "中文",
    observation_mode: "delta",
  });
  assert.equal(changed.outcome, "executed", changed.error);
  assert.equal(changed.observation, undefined);
  const filled = restore(full.observation, changed);
  assert.ok(
    filled.elements.some((entry) => entry.description.includes("中文")),
  );
  assert.notEqual(current.id, first.observation.id);
  assert.equal(
    (
      await f.run({
        action: "click",
        ...ref(filled, "保存"),
        observation_mode: "none",
      })
    ).outcome,
    "executed",
  );
});

test("extension 批量 none 省掉底层采集，旧引用和坐标失效，显式观察回退full", async (t) => {
  const f = await fixture(
    t,
    '<label>姓名<input></label><button onclick="document.body.dataset.saved=1">保存</button>',
  );
  const captures = countCaptures(f);
  const first = await f.run({ action: "screenshot", page: f.id });
  const before = captures();
  assert.ok(before > 0);
  const result = await f.run({
    action: "batch",
    page: f.id,
    observation: first.observation.id,
    observation_mode: "none",
    steps: [
      {
        action: "fill",
        ref: ref(first.observation, 'input "姓名"').ref,
        text: "批量",
      },
      { action: "click", ref: ref(first.observation, "保存").ref },
    ],
  });
  assert.equal(result.outcome, "executed", result.error);
  assert.equal(result.steps.length, 2);
  assert.equal(result.observation, undefined);
  assert.equal(result.observation_update, undefined);
  assert.equal(captures(), before);
  assert.equal(await f.page.locator("input").inputValue(), "批量");
  const stale = await f.run({
    action: "pointer",
    page: f.id,
    observation: first.observation.id,
    x: 10,
    y: 10,
    button: "left",
    clicks: 1,
  });
  assert.equal(stale.outcome, "not_executed");
  const next = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: first.observation.id,
  });
  assert.equal(next.observation_update.kind, "full");
  assert.equal(next.observation_update.reset_reason, "invalidated");
  assert.ok(captures() > before);
});

test("extension 静默属性变化仍采集，handoff和导航后的增量明确回退", async (t) => {
  const f = await fixture(t, "<label>姓名<input></label>");
  const first = await f.observe();
  await f.page.locator("input").evaluate((node) => {
    node.value = "静默变更";
  });
  const changed = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: first.observation.id,
  });
  assert.ok(
    restore(first.observation, changed).elements.some((entry) =>
      entry.description.includes("静默变更"),
    ),
  );
  await f.run({ action: "handoff" });
  await f.run({ action: "resume" });
  const resumed = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: changed.observation_update.id,
  });
  assert.equal(resumed.observation_update.reset_reason, "invalidated");
  await f.page.goto(`${f.origin}/new`);
  const navigated = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: resumed.observation.id,
  });
  assert.equal(navigated.observation_update.reset_reason, "invalidated");
});

test("extension none 后语义定位重新解析，旧ref不会复活", async (t) => {
  const f = await fixture(t, "<label>姓名<input></label><button>保存</button>");
  f.captures = countCaptures(f);
  await exerciseSemanticObservation(f);
});

test("extension 原生WebMCP调用的none和unknown撤销旧观察", async (t) => {
  const f = await fixture(
    t,
    "<label>姓名<input></label><button>保存</button>",
    undefined,
    { args: ["--enable-blink-features=WebMCP"] },
  );
  f.captures = countCaptures(f);
  await exerciseWebMcpObservation(f);
});
