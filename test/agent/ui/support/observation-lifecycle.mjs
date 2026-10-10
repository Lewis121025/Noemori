import assert from "node:assert/strict";

function button(observation) {
  const entry = observation.elements.find(
    (item) => item.description === 'button "保存"',
  );
  assert.ok(entry, "必须使用真实观察中的按钮引用");
  return {
    page: observation.page,
    observation: observation.id,
    ref: entry.ref,
  };
}

/** 同一真实浏览器接口上的生命周期断言，语义目标每次独立解析，不能复活旧引用。 */
export async function exerciseSemanticObservation(f) {
  const first = await f.run({ action: "observe", page: f.id });
  const before = f.captures();
  const click = await f.run({
    action: "click",
    ...button(first.observation),
    observation_mode: "none",
  });
  assert.equal(click.outcome, "executed", click.error);
  const semantic = await f.run({
    action: "locator",
    page: f.id,
    locator: { chain: [{ kind: "label", value: "姓名" }] },
    operation: "fill",
    text: "新定位",
    observation_mode: "none",
  });
  assert.equal(semantic.outcome, "executed", semantic.error);
  assert.equal(await f.page.locator("input").inputValue(), "新定位");
  assert.equal(f.captures(), before);
  assert.equal(
    (await f.run({ action: "click", ...button(first.observation) })).outcome,
    "not_executed",
  );
  const refreshed = await f.run({ action: "observe", page: f.id });
  assert.ok(
    refreshed.observation.elements.some((entry) =>
      entry.description.includes("新定位"),
    ),
  );
}

/** 注册原生 WebMCP 工具并走真实 CDP 调用，验证省略采集和未知副作用撤销旧引用。 */
export async function exerciseWebMcpObservation(f) {
  await f.page.evaluate(() => {
    if (!document.modelContext?.registerTool)
      throw new Error("测试 Chromium 必须启用原生 WebMCP");
    for (const name of ["update", "fail"])
      document.modelContext.registerTool({
        name,
        description: "观察生命周期隔离测试",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async (input) => {
          document.body.dataset.webmcp = input.text;
          if (name === "fail") throw new Error("已执行后报告失败");
          return JSON.stringify({ saved: true });
        },
      });
  });
  const first = await f.run({ action: "observe", page: f.id });
  const state = await f.run({ action: "capabilities_list", page: f.id });
  assert.equal(state.outcome, "observed", state.error);
  assert.ok(
    state.extensions.capabilities.some((entry) => entry.name === "webmcp"),
  );
  const granted = await f.run({
    action: "grant_capability",
    page: f.id,
    document: state.extensions.document,
    origin: state.extensions.origin,
    revision: state.extensions.revision,
    capability: "webmcp",
  });
  assert.equal(granted.extensions.granted, true);
  const prepare = async (name, text) => {
    const listed = await f.run({ action: "webmcp_list", page: f.id });
    const tool = listed.extensions.tools.find((tool) => tool.name === name);
    assert.ok(tool, `${name} 必须来自原生工具目录`);
    const prepared = await f.run({
      action: "webmcp_prepare",
      page: f.id,
      directory: listed.extensions.directory,
      tool: tool.id,
      input: { text },
    });
    assert.equal(prepared.outcome, "observed", prepared.error);
    return prepared.extensions.prepared;
  };
  const prepared = await prepare("update", "真实工具成功");
  const before = f.captures();
  const invoked = await f.run({
    action: "webmcp_invoke",
    page: f.id,
    prepared,
    observation_mode: "none",
  });
  assert.equal(invoked.outcome, "executed", invoked.error);
  assert.equal(
    await f.page.locator("body").getAttribute("data-webmcp"),
    "真实工具成功",
  );
  assert.equal(invoked.observation, undefined);
  assert.equal(f.captures(), before);
  assert.equal(
    (await f.run({ action: "click", ...button(first.observation) })).outcome,
    "not_executed",
  );
  const refreshed = await f.run({ action: "observe", page: f.id });
  const failure = await prepare("fail", "未知副作用");
  const unknown = await f.run({
    action: "webmcp_invoke",
    page: f.id,
    prepared: failure,
    observation_mode: "none",
  });
  assert.equal(unknown.outcome, "unknown", unknown.error);
  assert.equal(
    await f.page.locator("body").getAttribute("data-webmcp"),
    "未知副作用",
  );
  assert.equal(
    (await f.run({ action: "click", ...button(refreshed.observation) }))
      .outcome,
    "not_executed",
  );
  const recovered = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: refreshed.observation.id,
  });
  assert.equal(recovered.observation_update.reset_reason, "invalidated");
}
