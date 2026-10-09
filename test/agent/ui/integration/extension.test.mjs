import test from "node:test";
import assert from "node:assert/strict";
import { fixture, ref } from "../support/browser.mjs";

test("扩展预览保持原观察，新页面只在不激活的专用窗口内创建", async (t) => {
  const f = await fixture(t, '<label>姓名<input></label>');
  const first = await f.observe();
  const preview = await f.run({ action: "preview", page: f.id });
  assert.equal(preview.outcome, "observed");
  assert.equal(preview.image_format, "jpeg");
  assert.equal(preview.observation, undefined);
  const result = await f.run({ action: "fill", ...ref(first.observation, 'input "姓名"'), text: "继续" });
  assert.equal(result.outcome, "executed");
  const windows = [], tabs = [];
  globalThis.chrome.windows = { async create(options) { windows.push(options); return { id: 42, tabs: [{ id: 1 }] }; } };
  globalThis.chrome.tabs.create = async (options) => { tabs.push(options); return { id: 1 }; };
  assert.equal((await f.run({ action: "open", url: f.origin })).outcome, "executed");
  assert.equal((await f.run({ action: "open", url: f.origin })).outcome, "executed");
  assert.deepEqual(windows, [{ url: `${f.origin}/`, focused: false, type: "normal" }]);
  assert.deepEqual(tabs, [{ windowId: 42, url: `${f.origin}/`, active: false }]);
  f.browser.windowClosed(42);
  assert.equal((await f.run({ action: "open", url: f.origin })).outcome, "executed");
  assert.equal(windows.length, 2);
});

test("扩展表单、中文输入与键盘使用真实 DOM 和事件", async (t) => {
  const f = await fixture(
    t,
    "<label>姓名<input></label><button onclick=\"document.body.dataset.saved=document.querySelector('input').value\">保存</button>",
  );
  let result = await f.observe();
  result = await f.run({
    action: "fill",
    ...ref(result.observation, 'input "姓名"'),
    text: "测试",
  });
  assert.equal(result.outcome, "executed");
  result = await f.run({ action: "press", ...ref(result.observation, 'input "姓名"'), key: "End" });
  result = await f.run({
    action: "press",
    page: f.id,
    observation: result.observation.id,
    key: "x",
  });
  assert.equal(await f.page.locator("input").inputValue(), "测试x");
  result = await f.run({
    action: "type",
    page: f.id,
    observation: result.observation.id,
    text: "中文",
  });
  result = await f.run({ action: "click", ...ref(result.observation, "保存") });
  assert.equal(result.outcome, "executed");
  assert.equal(await f.page.locator("body").getAttribute("data-saved"), "测试x中文");
});

test("替换节点和虚拟列表复用语义都拒绝旧引用", async (t) => {
  const f = await fixture(
    t,
    '<ul><li><span>A</span><button onclick="window.clicked=true">删除</button></li></ul>',
  );
  const first = await f.observe();
  await f.page.locator("span").evaluate((node) => {
    node.textContent = "B";
  });
  let result = await f.run({ action: "click", ...ref(first.observation, "删除") });
  assert.equal(result.outcome, "not_executed");
  const next = await f.observe();
  await f.page.locator("button").evaluate((node) => {
    node.outerHTML = '<button onclick="window.clicked=true">删除</button>';
  });
  result = await f.run({ action: "click", ...ref(next.observation, "删除") });
  assert.equal(result.outcome, "not_executed");
  assert.equal(await f.page.evaluate(() => window.clicked), undefined);
});

test("跨域嵌套 iframe 与 Shadow DOM 采集和点击", async (t) => {
  const f = await fixture(t, '<iframe id="outer" style="width:700px;height:400px"></iframe>');
  const host = f.origin.replace("127.0.0.1", "localhost");
  await f.page.locator("iframe").evaluate((frame, url) => {
    frame.src = url;
  }, `${host}/child`);
  const outer = await f.page.locator("iframe").elementHandle();
  const frame = await outer.contentFrame();
  await frame.waitForLoadState();
  await frame.setContent(
    '<div id="shadow"></div><iframe srcdoc="<button onclick=\'document.body.dataset.clicked=1\'>嵌套目标</button>"></iframe>',
  );
  await frame.evaluate(() => {
    const root = document.querySelector("#shadow").attachShadow({ mode: "open" });
    root.innerHTML = '<button onclick="document.body.dataset.shadow=1">影子目标</button>';
  });
  const result = await f.observe();
  assert.equal(result.outcome, "observed");
  assert.ok(
    result.observation.elements.some((entry) => entry.description.includes("影子目标")),
    JSON.stringify(result),
  );
  assert.ok(
    result.observation.elements.some((entry) => entry.description.includes("嵌套目标")),
    JSON.stringify(result),
  );
  const clicked = await f.run({ action: "click", ...ref(result.observation, "嵌套目标") });
  assert.equal(clicked.outcome, "executed", JSON.stringify(clicked));
  assert.equal(await frame.childFrames()[0].evaluate(() => document.body.dataset.clicked), "1");
});

test("父页面遮挡 iframe 时拒绝点击遮挡物", async (t) => {
  const f = await fixture(
    t,
    '<iframe style="width:400px;height:200px" srcdoc="<button onclick=\'document.body.dataset.clicked=1\'>子按钮</button>"></iframe>',
  );
  const first = await f.observe();
  await f.page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:99999";
    overlay.onclick = () => {
      document.body.dataset.overlay = "clicked";
    };
    document.body.append(overlay);
  });
  const result = await f.run({ action: "click", ...ref(first.observation, "子按钮") });
  assert.equal(result.outcome, "not_executed");
  assert.equal(await f.page.locator("body").getAttribute("data-overlay"), null);
});

test("批量操作保留每一步原始引用且取消后不派发新输入", async (t) => {
  const f = await fixture(
    t,
    '<label>姓名<input></label><button onclick="document.body.dataset.saved=1">保存</button>',
  );
  const first = await f.observe();
  const result = await f.run({
    action: "batch",
    page: f.id,
    observation: first.observation.id,
    steps: [
      { action: "fill", ref: ref(first.observation, 'input "姓名"').ref, text: "用户" },
      { action: "click", ref: ref(first.observation, "保存").ref },
    ],
  });
  assert.equal(result.outcome, "executed", JSON.stringify(result));
  assert.equal(await f.page.locator("body").getAttribute("data-saved"), "1");
  const abort = new AbortController();
  abort.abort();
  const cancelled = await f.run(
    { action: "fill", ...ref(result.observation, 'input "姓名"'), text: "错误" },
    abort.signal,
  );
  assert.equal(cancelled.outcome, "not_executed");
  assert.equal(await f.page.locator("input").inputValue(), "用户");
});

test("固定字节上传与截图布局变化核验", async (t) => {
  const f = await fixture(t, '<label>上传<input type="file"></label><button>目标</button>');
  let result = await f.observe();
  result = await f.run({
    action: "upload_bytes",
    ...ref(result.observation, 'input(file) "上传"'),
    files: [
      {
        name: "测试.txt",
        mime_type: "text/plain",
        data: Buffer.from("中文文件").toString("base64"),
      },
    ],
  });
  assert.equal(result.outcome, "executed", JSON.stringify(result));
  assert.equal(await f.page.locator("input").evaluate((node) => node.files[0].text()), "中文文件");
  result = await f.run({ action: "screenshot", page: f.id });
  assert.equal(result.outcome, "observed", JSON.stringify(result));
  assert.ok(result.image_data.length > 100);
  await f.page.locator("button").evaluate((node) => {
    node.style.marginLeft = "100px";
  });
  const click = await f.run({
    action: "pointer",
    page: f.id,
    observation: result.observation.id,
    x: 100,
    y: 100,
    button: "left",
    clicks: 1,
  });
  assert.equal(click.outcome, "not_executed");
});

test("HTTP POST 下载读取原响应且只提交一次", async (t) => {
  let requests = 0;
  const f = await fixture(
    t,
    '<form method="post" action="/download"><button>下载报告</button></form>',
    (request, response) => {
      if (request.url !== "/download") return false;
      assert.equal(request.method, "POST");
      requests++;
      response.writeHead(200, {
        "content-disposition": 'attachment; filename="report.txt"',
        "content-type": "application/octet-stream",
      });
      response.end("原始 POST 响应");
      return true;
    },
  );
  let result = await f.observe();
  await f.run({ action: "arm_download", page: f.id });
  result = await f.run({ action: "click", ...ref(result.observation, "下载报告") });
  const download = await f.run({ action: "await_download", page: f.id }, undefined, 10000);
  assert.equal(download.outcome, "observed", JSON.stringify(download));
  assert.equal(
    download.downloads.at(-1)?.status,
    "completed",
    JSON.stringify({ download, errors: f.errors.map(String) }),
  );
  assert.equal(requests, 1);
  assert.equal(f.files[0].bytes.toString(), "原始 POST 响应");
});

test("即时撤销 blob URL 后仍能捕获原字节", async (t) => {
  const f = await fixture(
    t,
    "<button onclick=\"const url=window.URL.createObjectURL(new Blob(['blob原字节']));const a=document.createElement('a');a.href=url;a.download='blob.txt';document.body.append(a);a.click();window.URL.revokeObjectURL(url);a.remove();\">下载 blob</button>",
  );
  const first = await f.observe();
  await f.run({ action: "arm_download", page: f.id });
  const clicked = await f.run({ action: "click", ...ref(first.observation, "下载 blob") });
  assert.equal(clicked.outcome, "executed", JSON.stringify(clicked));
  const download = await f.run({ action: "await_download", page: f.id }, undefined, 10000);
  assert.equal(
    download.downloads.at(-1)?.status,
    "completed",
    JSON.stringify({ download, errors: f.errors.map(String) }),
  );
  assert.equal(f.files[0].bytes.toString(), "blob原字节");
});

test("跨 frame 查找存在歧义时不滚动任何页面", async (t) => {
  const f = await fixture(
    t,
    '<div style="height:2000px"></div><button>重复目标</button><iframe srcdoc="<button>重复目标</button>"></iframe>',
  );
  await f.observe();
  const result = await f.run({ action: "find", page: f.id, text: "重复目标", exact: true });
  assert.equal(result.outcome, "not_executed", JSON.stringify(result));
  assert.equal(await f.page.evaluate(() => scrollY), 0);
});

test("正文分页包含嵌套 frame 与 Shadow DOM 的文字", async (t) => {
  const f = await fixture(
    t,
    '<p>父正文</p><div id="host"></div><iframe srcdoc="<p>子正文</p>"></iframe>',
  );
  await f.page.evaluate(() => {
    document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = "<p>影子正文</p>";
  });
  await f.observe();
  const result = await f.run({ action: "read", page: f.id, offset: 0 });
  assert.equal(result.outcome, "observed");
  assert.match(result.text_page.text, /子正文/);
  assert.match(result.text_page.text, /影子正文/);
});

test("像素坐标越界时不派发输入", async (t) => {
  const f = await fixture(t, "<button>目标</button>");
  const first = await f.run({ action: "screenshot", page: f.id });
  const result = await f.run({
    action: "pointer",
    page: f.id,
    observation: first.observation.id,
    x: 1400,
    y: 100,
    button: "left",
    clicks: 1,
  });
  assert.equal(result.outcome, "not_executed", JSON.stringify(result));
});

test("子 frame 布局变化会使旧截图定位失效", async (t) => {
  const f = await fixture(t, "<iframe srcdoc=\"<button id='target'>子目标</button>\"></iframe>");
  const first = await f.run({ action: "screenshot", page: f.id });
  await f.page
    .frames()[1]
    .locator("button")
    .evaluate((node) => {
      node.style.marginLeft = "100px";
    });
  const result = await f.run({
    action: "pointer",
    page: f.id,
    observation: first.observation.id,
    x: 20,
    y: 20,
    button: "left",
    clicks: 1,
  });
  assert.equal(result.outcome, "not_executed", JSON.stringify(result));
});

test("长业务行复用节点不能因为描述截断而复用语义", async (t) => {
  const f = await fixture(
    t,
    `<ul><li><span>${"长".repeat(500)}记录A</span><button onclick="window.clicked=true">删除</button></li></ul>`,
  );
  const first = await f.observe();
  await f.page.locator("span").evaluate((node) => {
    node.textContent = node.textContent.replace("记录A", "记录B");
  });
  const result = await f.run({ action: "click", ...ref(first.observation, 'button "删除"') });
  assert.equal(result.outcome, "not_executed", JSON.stringify(result));
  assert.equal(await f.page.evaluate(() => window.clicked), undefined);
});
