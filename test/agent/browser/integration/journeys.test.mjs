import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserEngine } from "../../../../modules/agent/web-runtime/dist/browser/engine.js";
import { startBenchmarkSite } from "../support/benchmark-site.mjs";

const require = createRequire(
  new URL("../../../../modules/agent/web-runtime/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");

test("八类用户任务用服务器核验结果，覆盖与 Codex 对照的同一组页面", async (t) => {
  const site = await startBenchmarkSite();
  let root, browser, engine;
  t.after(async () => {
    const errors = [];
    for (const close of [
      () => engine?.close(),
      () => browser?.close(),
      () => site.close(),
      () => (root ? rm(root, { recursive: true, force: true }) : undefined),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "任务验收资源没有正常回收");
  });
  root = await realpath(await mkdtemp(join(tmpdir(), "noemori-browser-journeys-")));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NOEMORI_TEST_BROWSER
      ? { executablePath: process.env.NOEMORI_TEST_BROWSER }
      : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  engine = new BrowserEngine(context, {
    workspace: root,
    download_directory: join(root, "downloads"),
    max_pages: 12,
    max_chars: 24000,
    max_elements: 250,
    max_download_bytes: 1048576,
  });
  let observation;
  let page;
  async function run(action) {
    const result = await engine.dispatch(action, new AbortController().signal, 5000);
    if (result.observation) observation = result.observation;
    assert.notEqual(result.outcome, "not_executed", result.error);
    return result;
  }
  async function open(task) {
    const result = await run({ action: "open", url: `${site.origin}/${task}?run=project` });
    assert.equal(result.outcome, "executed", result.error);
    page = result.observation.page;
  }
  function ref(name) {
    const element = observation.elements.find((element) => element.description.includes(name));
    assert.ok(element, `观察中缺少 ${name}`);
    return element.ref;
  }
  async function input(action, name, rest = {}) {
    return run({ action, page, observation: observation.id, ref: ref(name), ...rest });
  }
  async function complete() {
    const result = await run({ action: "wait", page, text: "验收通过", state: "visible" });
    assert.equal(result.outcome, "observed", result.error);
    await run({ action: "close", page });
  }

  await open("form");
  const form = await run({
    action: "batch",
    page,
    observation: observation.id,
    steps: [
      { action: "fill", ref: ref("姓名"), text: "林川" },
      { action: "select", ref: ref("地区"), values: ["日本"] },
      { action: "select", ref: ref("配送"), values: ["次日送达"] },
      { action: "check", ref: ref("开具发票"), checked: true },
      { action: "click", ref: ref("提交") },
    ],
  });
  assert.equal(form.steps.length, 5);
  await complete();

  await open("frame");
  await run({ action: "wait", page, text: "表单已就绪", state: "visible" });
  await input("fill", "项目代号", { text: "NOTE-42" });
  await input("click", "提交项目");
  await complete();

  await open("list");
  await run({ action: "find", page, text: "INV-057" });
  await input("click", "INV-057");
  await complete();

  await open("dialog");
  const confirm = await input("click", "新增记录");
  assert.equal(confirm.tabs.find((tab) => tab.id === page).dialog.type, "confirm");
  const alert = await run({ action: "dialog", page, accept: true });
  assert.equal(alert.tabs.find((tab) => tab.id === page).dialog.type, "alert");
  await run({ action: "dialog", page, accept: true });
  await complete();

  await open("tabs");
  await input("click", "打开详情页");
  let detail;
  // 点击已经派发不代表新窗口导航已经提交；只重新观察标签页，不能重复点击链接。
  for (let attempt = 0; attempt < 50; attempt++) {
    detail = (await run({ action: "tabs" })).tabs.find((tab) => tab.url.includes("/detail?"));
    if (detail) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(detail);
  const read = await run({ action: "read", page: detail.id });
  assert.match(read.text_page.text, /BENCH-42/);
  await run({ action: "observe", page });
  await input("fill", "校验码", { text: "BENCH-42" });
  await input("click", "提交");
  await run({ action: "close", page: detail.id });
  await complete();

  await open("files");
  await input("click", "下载测试附件");
  let download;
  for (let attempt = 0; attempt < 50; attempt++) {
    download = (await run({ action: "downloads" })).downloads[0];
    if (download?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(download.status, "completed");
  await run({ action: "save_download", id: download.id, path: "receipt.txt" });
  await input("click", "上传附件");
  await run({ action: "choose_files", page, paths: ["receipt.txt"] });
  await input("click", "提交验证");
  await complete();

  await open("canvas");
  const screenshot = await run({ action: "screenshot", page });
  assert.ok(screenshot.image.data);
  const canvas = await context.pages()[0].locator("canvas").boundingBox();
  assert.ok(canvas);
  await run({
    action: "drag",
    page,
    observation: observation.id,
    from_x: Math.round(canvas.x + 106),
    from_y: Math.round(canvas.y + 116),
    to_x: Math.round(canvas.x + 481),
    to_y: Math.round(canvas.y + 121),
  });
  await complete();

  await open("navigation");
  await input("click", "已完成");
  await run({ action: "wait", page, text: "Beta", state: "visible" });
  await input("click", "Beta");
  await input("click", "确认");
  await complete();

  const results = await (await fetch(`${site.origin}/results`)).json();
  assert.equal(Object.keys(results).length, 8);
  for (const result of Object.values(results))
    assert.deepEqual(result, { passed: true, submissions: 1 });
  assert.deepEqual(engine.tabs(), []);
});
