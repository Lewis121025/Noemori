import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { BrowserEngine } from "../../../../modules/agent/web-runtime/dist/browser/engine.js";
import {
  exerciseSemanticObservation,
  exerciseWebMcpObservation,
} from "../../ui/support/observation-lifecycle.mjs";

const require = createRequire(
  new URL(
    "../../../../modules/agent/web-runtime/package.json",
    import.meta.url,
  ),
);
const { chromium } = require("playwright-core");

async function fixture(t, webmcp = false, networkErrors = () => new Set()) {
  const root = await mkdtemp(join(tmpdir(), "noemori-observation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const browser = await chromium.launch({
    headless: true,
    ...(webmcp ? { args: ["--enable-blink-features=WebMCP"] } : {}),
    ...(process.env.NOEMORI_TEST_BROWSER
      ? { executablePath: process.env.NOEMORI_TEST_BROWSER }
      : {}),
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  const page = await context.newPage();
  const html =
    '<label>姓名<input></label><button onclick="document.body.dataset.saved=1">保存</button>';
  if (webmcp) {
    const server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
  } else await page.setContent(html);
  const engine = new BrowserEngine(context, {
    workspace: root,
    download_directory: join(root, "downloads"),
    max_pages: 8,
    max_chars: 24000,
    max_elements: 250,
    max_download_bytes: 1048576,
  }, undefined, undefined, false, networkErrors);
  t.after(() => engine.close());
  const id = engine.tabs()[0].id;
  const entry = engine.pages.get(id);
  let captures = 0;
  const capture = entry.captureContent.bind(entry);
  entry.captureContent = (...args) => {
    captures++;
    return capture(...args);
  };
  return {
    page,
    entry,
    id,
    run: (action) => engine.execute(action, new AbortController().signal, 5000),
    captures: () => captures,
  };
}
function target(observation, name) {
  const matches = observation.elements.filter((entry) =>
    entry.description.includes(name),
  );
  assert.equal(matches.length, 1);
  return {
    page: observation.page,
    observation: observation.id,
    ref: matches[0].ref,
  };
}
function restore(previous, result) {
  const update = result.observation_update;
  assert.equal(update.base, previous.id);
  assert.equal(update.target, previous.page);
  return { ...previous, ...update.changes, id: update.id };
}

test("managed 增量包含新引用，无变化也拒绝旧身份，显式完整可恢复证据", async (t) => {
  const f = await fixture(t);
  const first = await f.run({ action: "observe", page: f.id });
  const unchanged = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: first.observation.id,
  });
  assert.equal(unchanged.observation, undefined);
  assert.equal(unchanged.observation_update.kind, "unchanged");
  const current = restore(first.observation, unchanged);
  assert.notEqual(current.id, first.observation.id);
  assert.equal(
    (await f.run({ action: "click", ...target(first.observation, "保存") }))
      .outcome,
    "not_executed",
  );
  const full = await f.run({ action: "observe", page: f.id, mode: "full" });
  assert.ok(full.observation.elements.length);
  assert.equal(full.observation_update, undefined);
  const changed = await f.run({
    action: "fill",
    ...target(full.observation, "姓名"),
    text: "中文",
    observation_mode: "delta",
  });
  assert.equal(changed.outcome, "executed");
  assert.equal(changed.observation, undefined);
  const filled = restore(full.observation, changed);
  assert.ok(
    filled.elements.some((entry) => entry.description.includes("中文")),
  );
  const saved = await f.run({
    action: "click",
    ...target(filled, "保存"),
    observation_mode: "none",
  });
  assert.equal(saved.outcome, "executed");
  assert.equal(await f.page.locator("body").getAttribute("data-saved"), "1");
});

test("网络警告在完整与增量编码前进入基线，新警告及消失都必须可还原", async (t) => {
  const errors = new Set();
  const f = await fixture(t, false, () => errors);
  const first = await f.run({ action: "observe", page: f.id });
  const capture = f.entry.captureContent.bind(f.entry);
  f.entry.captureContent = async (...args) => {
    const content = await capture(...args);
    errors.add("浏览器网络失败：受控资源连接重置");
    return content;
  };
  const changed = await f.run({
    action: "observe", page: f.id, mode: "delta", baseline: first.observation.id,
  });
  const current = restore(first.observation, changed);
  assert.equal(changed.observation_update.kind, "delta");
  assert.deepEqual(current.warnings, [...errors]);
  assert.deepEqual(f.entry.observation.warnings, current.warnings);
  f.entry.captureContent = capture;
  const cleared = await f.run({
    action: "observe", page: f.id, mode: "delta", baseline: current.id,
  });
  assert.equal(cleared.observation_update.kind, "delta");
  assert.deepEqual(restore(current, cleared).warnings, []);
  f.entry.captureContent = async (...args) => {
    const content = await capture(...args);
    errors.add("浏览器网络失败：另一受控资源超时");
    return content;
  };
  const full = await f.run({ action: "observe", page: f.id, mode: "full" });
  assert.deepEqual(full.observation.warnings, ["浏览器网络失败：另一受控资源超时"]);
  assert.deepEqual(f.entry.observation.warnings, full.observation.warnings);
  f.entry.captureContent = async () => {
    errors.add("浏览器网络失败：受控资源拒绝连接");
    throw new Error("受控观察异常");
  };
  const failed = await f.run({ action: "observe", page: f.id });
  assert.match(failed.error, /受控观察异常；网络出口：浏览器网络失败：受控资源拒绝连接/);
});

test("managed none 与批量 none 实际省掉采集，同时撤销旧引用及截图", async (t) => {
  const f = await fixture(t);
  const first = await f.run({ action: "screenshot", page: f.id });
  assert.ok(first.image);
  const before = f.captures();
  const result = await f.run({
    action: "batch",
    page: f.id,
    observation: first.observation.id,
    observation_mode: "none",
    steps: [
      {
        action: "fill",
        ref: target(first.observation, "姓名").ref,
        text: "批量",
      },
      { action: "click", ref: target(first.observation, "保存").ref },
    ],
  });
  assert.equal(result.outcome, "executed", result.error);
  assert.equal(result.steps.length, 2);
  assert.equal(result.observation, undefined);
  assert.equal(result.observation_update, undefined);
  assert.equal(f.captures(), before);
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
  assert.equal(f.captures(), before + 1);
});

test("managed 属性无事件变化也被真实采集，导航与人工交还撤销增量基线", async (t) => {
  const f = await fixture(t);
  const first = await f.run({ action: "observe", page: f.id });
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
  await f.run({ action: "takeover" });
  await f.run({ action: "resume" });
  const resumed = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: changed.observation_update.id,
  });
  assert.equal(resumed.observation_update.reset_reason, "invalidated");
  await f.page.goto(
    `data:text/html;charset=utf-8,${encodeURIComponent("<button>新页面</button>")}`,
  );
  const navigated = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: resumed.observation.id,
  });
  assert.equal(navigated.observation_update.reset_reason, "invalidated");
  assert.ok(navigated.observation.text.includes("新页面"));
});

test("managed none 后语义定位重新解析，旧ref不会复活", async (t) => {
  await exerciseSemanticObservation(await fixture(t));
});

test("managed 原生WebMCP调用的none和unknown撤销旧观察", async (t) => {
  await exerciseWebMcpObservation(await fixture(t, true));
});

test("managed 释放旧句柄期间的导航也会撤销增量基线", async (t) => {
  const f = await fixture(t);
  const first = await f.run({ action: "observe", page: f.id });
  const invalidate = f.entry.invalidate.bind(f.entry);
  let navigate = true;
  f.entry.invalidate = async () => {
    await invalidate();
    if (navigate) {
      navigate = false;
      await f.page.goto(
        `data:text/html;charset=utf-8,${encodeURIComponent("<button>导航后</button>")}`,
      );
    }
  };
  const result = await f.run({
    action: "observe",
    page: f.id,
    mode: "delta",
    baseline: first.observation.id,
  });
  assert.equal(result.outcome, "observed", result.error);
  assert.equal(result.observation_update.kind, "full");
  assert.equal(result.observation_update.reset_reason, "invalidated");
  assert.ok(result.observation.text.includes("导航后"));
});
