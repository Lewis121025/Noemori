import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixture } from "../../ui/support/browser.mjs";
import { BrowserEngine } from "../../../../modules/agent/web-runtime/dist/browser/engine.js";

async function backend(t, kind, html, respond) {
  if (kind === "extension") return fixture(t, html, respond);
  const root = await mkdtemp(join(tmpdir(), "noemori-semantic-"));
  const server = createServer((request, response) => {
    if (respond?.(request, response)) return;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const require = createRequire(
    new URL("../../../../modules/agent/web-runtime/package.json", import.meta.url),
  );
  const browser = await require("playwright-core").chromium.launch({
    headless: true,
    ...(process.env.NOEMORI_TEST_BROWSER
      ? { executablePath: process.env.NOEMORI_TEST_BROWSER }
      : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(origin);
  const engine = new BrowserEngine(context, {
    workspace: root,
    download_directory: root,
    max_pages: 10,
    max_chars: 24000,
    max_elements: 250,
    max_download_bytes: 4 * 1024 * 1024,
  });
  t.after(async () => {
    await engine.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const id = engine.tabs()[0].id;
  const run = (value, signal = new AbortController().signal) =>
    engine.dispatch({ ...value, page: id }, signal, 5000);
  return { page, context, origin, id, run, observe: () => run({ action: "observe" }) };
}
const query = (kind, value, options = {}) => ({ kind, value, ...options });
function action(f, chain, operation, values = {}, frames = []) {
  return f.run({ action: "locator", page: f.id, locator: { chain, frames }, operation, ...values });
}

for (const kind of ["managed", "extension"]) {
  test(`${kind}语义查询使用ARIA名称、标签、占位文字、testId及文字`, async (t) => {
    const f = await backend(
      t,
      kind,
      '<span id="name">保存名字</span><button aria-labelledby="name" onclick="this.dataset.clicked=1">无关文字</button><label>姓名<input placeholder="请输入" data-testid="name"></label><input type="password" value="secret" data-testid="password"><p>精确文字</p>',
    );
    let result = await action(f, [query("role", "button", { name: "保存名字" })], "click");
    assert.equal(result.outcome, "executed", result.error);
    assert.equal(await f.page.locator("button").getAttribute("data-clicked"), "1");
    result = await action(f, [query("label", "姓名")], "fill", { text: "测试🙂" });
    assert.equal(result.outcome, "executed", result.error);
    result = await action(f, [query("placeholder", "请输入")], "inspect");
    assert.equal(result.outcome, "observed", result.error);
    assert.equal(result.locator_result.value, "测试🙂");
    assert.equal(
      (await action(f, [query("test_id", "password")], "inspect")).locator_result.value,
      null,
    );
    assert.equal((await action(f, [query("text", "精确文字")], "count")).locator_result.count, 1);
  });
  test(`${kind}歧义拒绝、作用域及相对过滤执行明确的按钮`, async (t) => {
    const f = await backend(
      t,
      kind,
      "<ul><li><span>甲</span><button onclick=\"window.clicked='甲'\">删除</button></li><li><span>乙</span><button onclick=\"window.clicked='乙'\">删除</button></li></ul>",
    );
    const ambiguous = await action(f, [query("role", "button", { name: "删除" })], "click");
    assert.equal(ambiguous.outcome, "not_executed");
    assert.equal(await f.page.evaluate(() => window.clicked), undefined);
    const chain = [
      query("role", "listitem", { filter: { has: [query("text", "乙")], has_not_text: "甲" } }),
      query("role", "button", { name: "删除" }),
    ];
    const exact = await action(f, chain, "click", { observation_mode: "none" });
    assert.equal(exact.outcome, "executed", exact.error);
    assert.equal(exact.observation, undefined);
    assert.equal(await f.page.evaluate(() => window.clicked), "乙");
  });
  test(`${kind}选择、勾选、键盘与Shadow DOM保持真实事件`, async (t) => {
    const f = await backend(
      t,
      kind,
      '<label for="city">城市</label><select id="city"><option value="a">甲城</option><option value="b">乙城</option></select><label>同意<input type="checkbox"></label><div id="host"></div><script>const root=document.querySelector("#host").attachShadow({mode:"open"});root.innerHTML=\'<label>影子<input></label>\';</script>',
    );
    const selected = await action(f, [query("label", "城市")], "select", {
      values: ["乙城"],
      by: "label",
    });
    assert.equal(selected.outcome, "executed", selected.error);
    assert.equal(await f.page.locator("select").inputValue(), "b");
    assert.equal(
      (await action(f, [query("label", "同意")], "check", { checked: true })).outcome,
      "executed",
    );
    assert.equal(await f.page.locator('[type="checkbox"]').isChecked(), true);
    assert.equal(
      (await action(f, [query("label", "影子")], "fill", { text: "abc" })).outcome,
      "executed",
    );
    assert.equal(
      (await action(f, [query("label", "影子")], "press", { key: "End" })).outcome,
      "executed",
    );
    assert.equal(
      (await action(f, [query("label", "影子")], "press", { key: "x" })).outcome,
      "executed",
    );
    assert.equal(await f.page.getByLabel("影子").inputValue(), "abcx");
  });
  test(`${kind}嵌套跨源iframe路径逐级唯一解析`, async (t) => {
    const f = await backend(
      t,
      kind,
      '<iframe data-testid="outer" style="width:700px;height:400px"></iframe>',
      (request, response) => {
        if (request.url === "/inner") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(
            '<label>内部<input></label><button onclick="document.body.dataset.saved=1">内部保存</button>',
          );
          return true;
        }
      },
    );
    const child = f.origin.replace("127.0.0.1", "localhost");
    await f.page.getByTestId("outer").evaluate((node, url) => {
      node.srcdoc = `<iframe data-testid="inner" src="${url}/inner" style="width:600px;height:250px"></iframe>`;
    }, child);
    await f.page
      .frameLocator('[data-testid="outer"]')
      .frameLocator('[data-testid="inner"]')
      .getByLabel("内部")
      .waitFor({ timeout: 5000 });
    const frames = [[query("test_id", "outer")], [query("test_id", "inner")]];
    const result = await action(f, [query("label", "内部")], "fill", { text: "跨框架" }, frames);
    assert.equal(result.outcome, "executed", result.error);
    assert.equal(
      (await action(f, [query("label", "内部")], "inspect", {}, frames)).locator_result.value,
      "跨框架",
    );
    const absent = await action(f, [query("label", "内部")], "fill", { text: "错误" });
    assert.equal(absent.outcome, "not_executed");
  });
  test(`${kind}取消和模型原始脚本在输入前拒绝`, async (t) => {
    const f = await backend(t, kind, '<button onclick="window.clicked=1">保存</button>');
    const cancel = new AbortController();
    cancel.abort();
    const result = await f.run(
      {
        action: "locator",
        page: f.id,
        locator: { chain: [query("role", "button", { name: "保存" })] },
        operation: "click",
      },
      cancel.signal,
    );
    assert.equal(result.outcome, "not_executed");
    assert.equal(await f.page.evaluate(() => window.clicked), undefined);
  });
  test(`${kind}普通iframe按真实URL唯一定位并保留后续相对frame作用域`, async (t) => {
    const f = await backend(
      t,
      kind,
      '<iframe style="width:700px;height:400px"></iframe>',
      (request, response) => {
        if (request.url === "/child") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(
            '<label>普通框架<input></label><iframe data-testid="nested" src="/leaf"></iframe>',
          );
          return true;
        }
        if (request.url === "/leaf") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end("<label>深层<input></label>");
          return true;
        }
      },
    );
    const url = `${f.origin.replace("127.0.0.1", "localhost")}/child`;
    await f.page.locator("iframe").evaluate((node, url) => {
      node.src = url;
    }, url);
    await f.page.frameLocator("iframe").getByLabel("普通框架").waitFor({ timeout: 5000 });
    const run = (chain, frames = []) =>
      f.run({
        action: "locator",
        page: f.id,
        locator: { frame_url: url, chain, frames },
        operation: "fill",
        text: "明确目标",
      });
    assert.equal((await run([query("label", "普通框架")])).outcome, "executed");
    const nested = await run([query("label", "深层")], [[query("test_id", "nested")]]);
    assert.equal(nested.outcome, "executed", nested.error);
    assert.equal(
      await f.page
        .frameLocator("iframe")
        .frameLocator('[data-testid="nested"]')
        .getByLabel("深层")
        .inputValue(),
      "明确目标",
    );
    await f.page.evaluate((url) => {
      const iframe = document.createElement("iframe");
      iframe.src = url;
      document.body.append(iframe);
    }, url);
    await f.page
      .locator("iframe")
      .nth(1)
      .contentFrame()
      .getByLabel("普通框架")
      .waitFor({ timeout: 5000 });
    const duplicate = await run([query("label", "普通框架")]);
    assert.equal(duplicate.outcome, "not_executed");
  });
}
