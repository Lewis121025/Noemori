import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import {
  parseSemanticLocator,
  semanticSelector,
} from "../../../../modules/agent/web-runtime/dist/browser/semantic.js";

test("结构化查询拒绝脚本、CSS、超深过滤和超预算文本", () => {
  for (const raw of [
    { chain: [] },
    { chain: [{ kind: "css", value: "button" }] },
    { chain: [{ kind: "text", value: "x", script: "alert(1)" }] },
    { chain: [{ kind: "role", value: "button >> css=*" }] },
    { chain: [{ kind: "label", value: "x", name: "x" }] },
    { chain: [{ kind: "text", value: "x".repeat(4097) }] },
  ])
    assert.throws(() => parseSemanticLocator(raw));
  let chain = [{ kind: "text", value: "x" }];
  for (let depth = 0; depth < 10; depth++)
    chain = [{ kind: "role", value: "row", filter: { has: chain } }];
  assert.throws(() => parseSemanticLocator({ chain }));
});

test("查询中的引号与选择器分隔符始终编码为数据", () => {
  const locator = parseSemanticLocator({
    chain: [{ kind: "role", value: "button", name: '关闭" >> internal:text="删除' }],
  });
  assert.equal(
    semanticSelector(locator.chain),
    'internal:role=button[name="关闭\\\" >> internal:text=\\\"删除"s]',
  );
});

test("SDK定位器组合、过滤与frame路径不执行任意代码或跨页面过滤", async () => {
  const requests = [];
  const context = vm.createContext({
    __rpc: async (raw) => {
      const request = JSON.parse(raw);
      requests.push(request);
      return JSON.stringify({ outcome: "observed", tabs: [{ id: "page" }] });
    },
    __print() {},
    __image() {},
  });
  vm.runInContext(
    await readFile(
      new URL("../../../../modules/agent/src/tool/ui/sdk.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  await vm.runInContext(
    "(async()=>{const b=await browser.get('managed');const p=b.page('page');await p.getByRole('row').filter({has:p.getByText('甲')}).getByRole('button',{name:'删除'}).click({observation_mode:'none'});await p.frame({url:'https://example.test/child'}).getByTestId('frame').contentFrame().getByLabel('姓名').inspect();})()",
    context,
  );
  assert.deepEqual(
    requests.at(-2).action.locator.chain.map((q) => q.kind),
    ["role", "role"],
  );
  assert.equal(requests.at(-2).action.locator.chain[0].filter.has[0].value, "甲");
  assert.equal(requests.at(-2).action.observation_mode, "none");
  assert.equal(requests.at(-1).action.locator.frames[0][0].value, "frame");
  assert.equal(requests.at(-1).action.locator.frame_url, "https://example.test/child");
  const serialized = await vm.runInContext("(async()=>{const b=await browser.get('managed');return JSON.stringify(b.page('page'));})()", context);
  assert.equal(JSON.parse(serialized).id, "page");
  await assert.rejects(
    vm.runInContext(
      "(async()=>{const b=await browser.get('managed');b.page('page').getByText('甲').filter({has:b.page('other').getByText('乙')});})()",
      context,
    ),
  );
});
