import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const sdk = await readFile(
  new URL("../../../../modules/agent/src/tool/ui/sdk.js", import.meta.url),
  "utf8",
);
const snapshot = (id, target = "page") => ({
  id,
  page: target,
  text: "正文",
  elements: [{ ref: "e1", description: "按钮" }],
  truncated: false,
});

function guest() {
  const calls = [],
    replies = [];
  const context = createContext({
    __print() {},
    __image() {},
    async __rpc(raw) {
      const request = JSON.parse(raw);
      calls.push(request);
      return JSON.stringify(
        replies.shift() ?? {
          outcome: "observed",
          tabs: [{ id: "page" }],
          mode: "agent",
        },
      );
    },
  });
  runInContext(sdk, context);
  return {
    context,
    calls,
    replies,
    run: (code) => runInContext(`(async()=>{${code}})()`, context),
  };
}

test("SDK 自动以保留基线请求增量，并合并新身份与控件字段", async () => {
  const f = guest();
  await f.run(
    "globalThis.b=await browser.get('managed');globalThis.p=b.page('page');",
  );
  f.replies.push({ outcome: "observed", observation: snapshot("before") });
  await f.run("await p.observe();");
  f.replies.push({
    outcome: "observed",
    observation_update: {
      kind: "delta",
      id: "after",
      target: "page",
      base: "before",
      truncated: true,
      changes: {
        text: "新正文",
        elements: [{ ref: "e2", description: "新按钮" }],
        truncated: true,
      },
    },
  });
  const result = await f.run("return await p.observe({mode:'delta'});");
  assert.equal(result.observation, undefined);
  assert.equal(f.calls.at(-1).action.baseline, "before");
  assert.equal(f.context.p.observation, "after");
  assert.equal(f.context.p.snapshot.text, "新正文");
  assert.equal(f.context.p.snapshot.elements[0].ref, "e2");
  assert.equal(f.context.p.snapshot.truncated, true);
  f.replies.push({ outcome: "executed" });
  await f.run("await p.click('e2',{observation_mode:'none'});");
  assert.equal(f.calls.at(-1).action.observation, "after");
  assert.equal(f.calls.at(-1).action.observation_mode, "none");
  assert.equal(f.context.p.observation, null);
  assert.equal(f.context.p.snapshot, null);
});

test("新句柄无基线和变量重置后必须接受完整回退，无法套用另一目标增量", async () => {
  const f = guest();
  await f.run(
    "globalThis.b=await browser.get('managed');globalThis.p=b.page('page');",
  );
  f.replies.push({
    outcome: "observed",
    observation: snapshot("current"),
    observation_update: {
      kind: "full",
      id: "current",
      target: "page",
      truncated: false,
      reset_reason: "missing_baseline",
    },
  });
  await f.run("await p.observe({mode:'delta'});");
  assert.equal(f.calls.at(-1).action.baseline, undefined);
  assert.equal(f.context.p.observation, "current");
  f.replies.push({
    outcome: "observed",
    observation_update: {
      kind: "unchanged",
      id: "other",
      target: "different",
      base: "current",
      changes: {},
      truncated: false,
    },
  });
  await assert.rejects(f.run("await p.observe({mode:'delta'});"), /基线/);
  assert.equal(f.context.p.observation, null);
  const reset = guest();
  await reset.run(
    "globalThis.b=await browser.get('managed');globalThis.p=b.page('page');",
  );
  reset.replies.push({ outcome: "observed", observation: snapshot("reset") });
  await reset.run("await p.observe({mode:'delta'});");
  assert.equal(reset.calls.at(-1).action.baseline, undefined);
});

test("原生窗口使用同一增量协议，只读浏览器能力保留当前证据", async () => {
  const f = guest();
  await f.run(
    "globalThis.a=await computer.getApp('app');globalThis.w=a.window('window');",
  );
  f.replies.push({
    outcome: "observed",
    observation: { ...snapshot("before"), window: "window" },
  });
  await f.run("await w.observe();");
  f.replies.push({
    outcome: "executed",
    observation_update: {
      kind: "unchanged",
      id: "after",
      target: "window",
      base: "before",
      truncated: false,
      changes: {},
    },
  });
  await f.run("await w.setValue('e1','文字',{observation_mode:'delta'});");
  assert.equal(f.context.w.observation, "after");
  assert.equal(f.calls.at(-1).action.observation_mode, "delta");
  await f.run(
    "globalThis.b=await browser.get('managed');globalThis.p=b.page('page');",
  );
  f.replies.push({ outcome: "observed", observation: snapshot("browser") });
  await f.run("await p.observe();");
  await f.run("await p.action('developer_logs');");
  assert.equal(f.context.p.observation, "browser");
});

test("open省略观察也使用实际创建的页面身份，弹出标签页不能改变返回句柄", async () => {
  const f = guest();
  await f.run("globalThis.b=await browser.get('managed');");
  f.replies.push({
    outcome: "executed",
    page: "created",
    tabs: [{ id: "created" }, { id: "popup" }],
  });
  const page = await f.run(
    "return await b.open('https://example.test/',{observation_mode:'none'});",
  );
  assert.equal(page.id, "created");
  assert.equal(page.observation, null);
  assert.equal(page.snapshot, null);
});

test("失败只读回执清除旧snapshot与ref基线，后续动作不能再次携带旧观察", async () => {
  for (const code of [
    "await p.getByRole('button').inspect();",
    "await p.getByRole('button').count();",
    "await p.capabilities.get('developer_logs');",
    "await p.read();",
  ]) {
    const f = guest();
    await f.run(
      "globalThis.b=await browser.get('chrome');globalThis.p=b.page('page');",
    );
    f.replies.push({ outcome: "observed", observation: snapshot("before") });
    await f.run("await p.observe();");
    f.replies.push({ outcome: "not_executed", error: "后端已撤销当前观察" });
    await f.run(code);
    assert.equal(f.context.p.observation, null, code);
    assert.equal(f.context.p.snapshot, null, code);
    f.replies.push({ outcome: "not_executed", error: "需要重新观察" });
    await f.run("await p.click('e1');");
    assert.equal(f.calls.at(-1).action.observation, null);
    f.replies.push({ outcome: "observed", observation: snapshot("current") });
    await f.run("await p.observe({mode:'delta'});");
    assert.equal(f.calls.at(-1).action.baseline, undefined);
    assert.equal(f.context.p.observation, "current");
  }
});

test("成功只读与能力授权回执继续保留当前完整证据", async () => {
  const f = guest();
  await f.run(
    "globalThis.b=await browser.get('chrome');globalThis.p=b.page('page');",
  );
  f.replies.push({ outcome: "observed", observation: snapshot("before") });
  await f.run("await p.observe();");
  f.replies.push({ outcome: "observed", locator_result: { count: 1 } });
  await f.run("await p.getByRole('button').count();");
  assert.equal(f.context.p.observation, "before");
  f.replies.push({ outcome: "executed" });
  await f.run("await p.requestCapability('developer_logs','读取隔离日志');");
  assert.equal(f.context.p.observation, "before");
  assert.equal(f.context.p.snapshot.text, "正文");
});


test("页面协助绑定页面和完成条件，同时撤销旧观察", async () => {
  const f = guest();
  await f.run("globalThis.b=await browser.get('managed');globalThis.p=b.page('page');");
  f.replies.push({ outcome: "observed", observation: snapshot("before") });
  await f.run("await p.observe();");
  await f.run("await p.handoff({type:'text',text:'验证通过'});");
  assert.deepEqual(f.calls.at(-1).action, { action: "handoff", completion: { page: "page", until: { type: "text", text: "验证通过" } } });
  assert.equal(f.context.p.snapshot, null);
  assert.equal(f.context.p.observation, null);
});
