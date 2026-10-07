import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { BrowserEngine } from "../../../../modules/agent/web-runtime/dist/browser/engine.js";
import { limitDownloads } from "../../../../modules/agent/web-runtime/dist/browser/download-limit.js";
const require = createRequire(
  new URL("../../../../modules/agent/web-runtime/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");

async function fixture(t, html) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "noemori-browser-test-")));
  const artifacts = join(root, "artifacts");
  const browser = await chromium.launch({
    headless: true,
    artifactsDir: artifacts,
    downloadsPath: artifacts,
    ...(process.env.NOEMORI_TEST_BROWSER
      ? { executablePath: process.env.NOEMORI_TEST_BROWSER }
      : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const releaseDownloads = await limitDownloads(browser, context, artifacts, 1048576);
  await page.setContent(html);
  const engine = new BrowserEngine(context, {
    workspace: root,
    download_directory: join(root, "downloads"),
    max_pages: 8,
    max_chars: 20000,
    max_elements: 100,
    max_download_bytes: 1048576,
  });
  t.after(async () => {
    await engine.close();
    await releaseDownloads();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  });
  const id = engine.tabs()[0].id;
  const run = (action, signal = new AbortController().signal, timeout = 5000) =>
    engine.execute(action, signal, timeout);
  const observe = () => run({ action: "observe", page: id });
  return { root, page, engine, id, run, observe };
}
function ref(observation, name) {
  const element = observation.elements.find((entry) => entry.description.includes(name));
  assert.ok(element, `缺少控件 ${name}: ${JSON.stringify(observation.elements)}`);
  return { page: observation.page, observation: observation.id, ref: element.ref };
}

test("表单跨调用保留状态，工具结果包含执行后的真实页面", async (t) => {
  const f = await fixture(
    t,
    "<label>姓名<input></label><button onclick=\"document.body.dataset.saved=document.querySelector('input').value\">保存</button>",
  );
  const first = await f.observe();
  assert.equal(first.outcome, "observed");
  const filled = await f.run({
    action: "fill",
    ...ref(first.observation, "姓名"),
    text: "测试用户",
  });
  assert.equal(filled.outcome, "executed");
  const saved = await f.run({ action: "click", ...ref(filled.observation, "保存") });
  assert.equal(saved.outcome, "executed");
  assert.equal(await f.page.locator("body").getAttribute("data-saved"), "测试用户");
});

test("页面重绘不能把旧元素编号重新解释为其他控件", async (t) => {
  const f = await fixture(t, '<button onclick="window.clicked=true">删除 A</button>');
  const first = await f.observe();
  const target = ref(first.observation, "删除 A");
  await f.page.evaluate(() => {
    document.body.innerHTML = '<button onclick="window.clicked=true">删除 B</button>';
  });
  const result = await f.run({ action: "click", ...target });
  assert.equal(result.outcome, "not_executed");
  assert.match(result.error, /替换|改变/);
  assert.equal(await f.page.evaluate(() => window.clicked), undefined);
});

test("虚拟列表复用节点但更换业务内容也拒绝旧引用", async (t) => {
  const f = await fixture(
    t,
    '<ul><li><span>A</span><button onclick="window.clicked=true">删除</button></li></ul>',
  );
  const first = await f.observe();
  await f.page.locator("span").evaluate((element) => {
    element.textContent = "B";
  });
  const result = await f.run({ action: "click", ...ref(first.observation, "删除") });
  assert.equal(result.outcome, "not_executed");
  assert.equal(await f.page.evaluate(() => window.clicked), undefined);
});

test("等待控件可点击期间复用节点时，不能操作新的业务记录", async (t) => {
  const f = await fixture(
    t,
    "<ul><li><span>A</span><button disabled onclick=\"window.clicked=document.querySelector('span').textContent\">删除</button></li></ul>",
  );
  const first = await f.observe();
  await f.page.evaluate(() => {
    setTimeout(() => {
      document.querySelector("span").textContent = "B";
      document.querySelector("button").disabled = false;
    }, 400);
  });
  const result = await f.run({ action: "click", ...ref(first.observation, "删除") });
  assert.equal(await f.page.evaluate(() => window.clicked), undefined);
  assert.equal(result.outcome, "not_executed");
  assert.match(result.error, /改变|失效/);
});

test("等待输入框可编辑期间复用节点时，不能填写另一条记录", async (t) => {
  const f = await fixture(
    t,
    '<ul><li><span>A</span><input aria-label="备注" disabled oninput="window.changed=document.querySelector(\'span\').textContent"></li></ul>',
  );
  const first = await f.observe();
  await f.page.evaluate(() => {
    setTimeout(() => {
      document.querySelector("span").textContent = "B";
      document.querySelector("input").disabled = false;
    }, 400);
  });
  const result = await f.run({ action: "fill", ...ref(first.observation, "备注"), text: "新备注" });
  assert.equal(await f.page.evaluate(() => window.changed), undefined);
  assert.equal(result.outcome, "not_executed");
});

test("批量操作打开新标签页后停止后续输入，保留已完成步骤", async (t) => {
  const f = await fixture(
    t,
    '<button onclick="window.open(\'about:blank\')">打开详情</button><button onclick="window.changed=true">提交</button>',
  );
  const first = await f.observe();
  const result = await f.run({
    action: "batch",
    page: f.id,
    observation: first.observation.id,
    steps: [
      { action: "click", ref: ref(first.observation, "打开详情").ref },
      { action: "click", ref: ref(first.observation, "提交").ref },
    ],
  });
  assert.equal(await f.page.evaluate(() => window.changed), undefined);
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(
    result.steps.map(({ index, action, outcome }) => ({ index, action, outcome })),
    [
      { index: 0, action: "click", outcome: "executed" },
      { index: 1, action: "click", outcome: "not_executed" },
    ],
  );
  assert.match(result.steps[1].error, /标签页/);
  assert.equal(result.tabs.length, 2);
});

test("填写被聚焦弹窗中断后，关闭弹窗不能继续派发迟到文字", async (t) => {
  const f = await fixture(
    t,
    '<input aria-label="备注" onfocus="confirm(\'填写确认\')" oninput="window.changed=true">',
  );
  const first = await f.observe();
  const result = await f.run({
    action: "fill",
    ...ref(first.observation, "备注"),
    text: "迟到文字",
  });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.tabs[0].dialog.type, "confirm");
  await f.run({ action: "dialog", page: f.id, accept: true });
  await f.page.waitForTimeout(100);
  assert.equal(await f.page.locator("input").inputValue(), "");
  assert.equal(await f.page.evaluate(() => window.changed), undefined);
});

test("同名跨框架与 Shadow DOM 控件通过真实节点引用区分", async (t) => {
  const f = await fixture(
    t,
    '<button>保存</button><iframe srcdoc="<button onclick=&quot;document.body.dataset.saved=1&quot;>保存</button>"></iframe><div id="shadow"></div>',
  );
  await f.page.locator("#shadow").evaluate((element) => {
    element.attachShadow({ mode: "open" }).innerHTML = '<input aria-label="影子输入">';
  });
  const first = await f.observe();
  const inFrame = first.observation.elements.find(
    (element) => element.frame === "frame-1" && element.description.includes("保存"),
  );
  assert.ok(inFrame);
  const result = await f.run({
    action: "click",
    page: f.id,
    observation: first.observation.id,
    ref: inFrame.ref,
  });
  assert.equal(result.outcome, "executed");
  assert.equal(await f.page.frames()[1].locator("body").getAttribute("data-saved"), "1");
  assert.ok(
    result.observation.elements.some((element) => element.description.includes("影子输入")),
  );
});

test("人工接管暂停操作，交还后旧观察不能继续执行", async (t) => {
  const f = await fixture(t, "<button>保存</button>");
  const first = await f.observe();
  assert.equal((await f.run({ action: "handoff" })).mode, "human");
  assert.equal(
    (await f.run({ action: "click", ...ref(first.observation, "保存") })).outcome,
    "not_executed",
  );
  await f.run({ action: "resume" });
  const resumed = await f.run({ action: "click", ...ref(first.observation, "保存") });
  assert.equal(resumed.outcome, "not_executed");
  assert.match(resumed.error, /观察已失效/);
});

test("取消发生在控件等待期间时不会在控件可用后补点击", async (t) => {
  const f = await fixture(t, '<button disabled onclick="window.clicked=true">提交</button>');
  const first = await f.observe();
  const controller = new AbortController();
  const pending = f.run({ action: "click", ...ref(first.observation, "提交") }, controller.signal);
  controller.abort();
  await f.page.locator("button").evaluate((element) => {
    element.disabled = false;
  });
  assert.equal((await pending).outcome, "not_executed");
  assert.equal(await f.page.evaluate(() => window.clicked), undefined);
});

test("对话框不会自动接受，显式处理后恢复页面观察", async (t) => {
  const f = await fixture(
    t,
    "<button onclick=\"if(confirm('确定提交？'))document.body.dataset.saved=1\">提交</button>",
  );
  const first = await f.observe();
  const clicked = await f.run({ action: "click", ...ref(first.observation, "提交") });
  assert.ok(clicked.tabs[0].dialog);
  const dismissed = await f.run({ action: "dialog", page: f.id, accept: false });
  assert.equal(dismissed.outcome, "executed");
  assert.equal(await f.page.locator("body").getAttribute("data-saved"), null);
});

test("上传读取固定文件内容，拒绝工作区外文件", async (t) => {
  const f = await fixture(t, '<input type="file" aria-label="附件">');
  await writeFile(join(f.root, "input.txt"), "附件内容");
  const first = await f.observe();
  const result = await f.run({
    action: "upload",
    ...ref(first.observation, "附件"),
    paths: ["input.txt"],
  });
  assert.equal(result.outcome, "executed");
  assert.equal(
    await f.page.locator("input").evaluate((element) => element.files[0].name),
    "input.txt",
  );
  const outside = await f.run({
    action: "upload",
    ...ref(result.observation, "附件"),
    paths: ["/etc/hosts"],
  });
  assert.equal(outside.outcome, "not_executed");
  assert.match(outside.error, /工作区/);
});

test("坐标必须绑定当前截图；布局变化后旧坐标不能执行", async (t) => {
  const f = await fixture(t, "<button>保存</button>");
  const screenshot = await f.run({ action: "screenshot", page: f.id });
  assert.ok(screenshot.image.data);
  await f.page.locator("button").evaluate((element) => {
    element.style.marginLeft = "200px";
  });
  const result = await f.run({
    action: "pointer",
    page: f.id,
    observation: screenshot.observation.id,
    x: 20,
    y: 15,
    button: "left",
    clicks: 1,
  });
  assert.equal(result.outcome, "not_executed");
  assert.match(result.error, /页面已经变化/);
});

test("长列表滚动后能观察并操作后面的控件", async (t) => {
  const html = Array.from(
    { length: 1000 },
    (_, index) =>
      `<button style="display:block;height:30px" onclick="document.body.dataset.selected=${index}">项目 ${index}</button>`,
  ).join("");
  const f = await fixture(t, html);
  await f.page.locator("button").last().scrollIntoViewIfNeeded();
  const observed = await f.observe();
  const result = await f.run({ action: "click", ...ref(observed.observation, "项目 999") });
  assert.equal(result.outcome, "executed");
  assert.equal(await f.page.locator("body").getAttribute("data-selected"), "999");
});

test("服务端已接受提交但响应超时时，标记副作用未知并废弃旧观察", async (t) => {
  let submitted = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      submitted++;
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<form method="post"><button>提交</button></form>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const f = await fixture(t, "");
  await f.page.goto(`http://127.0.0.1:${server.address().port}`);
  const observation = await f.observe();
  const target = ref(observation.observation, "提交");
  const result = await f.run({ action: "click", ...target }, new AbortController().signal, 600);
  assert.equal(result.outcome, "unknown", JSON.stringify(result));
  assert.equal(submitted, 1);
  const stale = await f.run({ action: "click", ...target });
  assert.equal(stale.outcome, "not_executed");
  assert.equal(submitted, 1);
});

test("下载完成后才能保存，现有目标文件不得被覆盖", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="report.txt"',
    });
    response.end("测试下载");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const f = await fixture(t, `<a href="http://127.0.0.1:${server.address().port}">下载</a>`);
  const first = await f.observe();
  await f.run({ action: "click", ...ref(first.observation, "下载") });
  let download;
  for (let attempt = 0; attempt < 100; attempt++) {
    download = (await f.run({ action: "downloads" })).downloads[0];
    if (download?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(download.status, "completed");
  const saved = await f.run({ action: "save_download", id: download.id, path: "report.txt" });
  assert.equal(saved.outcome, "executed");
  const again = await f.run({ action: "save_download", id: download.id, path: "report.txt" });
  assert.notEqual(again.outcome, "executed");
});

test("下载超过文件预算时在网络流结束前取消", async (t) => {
  let sent = 0;
  const total = 8 * 1024 * 1024;
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="large.bin"',
      "content-length": total,
    });
    const timer = setInterval(() => {
      sent += 32768;
      response.write(Buffer.alloc(32768));
      if (sent >= total) {
        clearInterval(timer);
        response.end();
      }
    }, 10);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const f = await fixture(t, `<a href="http://127.0.0.1:${server.address().port}">下载</a>`);
  const first = await f.observe();
  await f.run({ action: "click", ...ref(first.observation, "下载") });
  let download;
  for (let attempt = 0; attempt < 150; attempt++) {
    download = (await f.run({ action: "downloads" })).downloads[0];
    if (download?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(download.status, "failed");
  assert.ok(sent < total, `预算必须在下载完成前执行，实际已发送 ${sent}`);
});

test("自定义上传按钮打开文件选择器后仍遵守工作区授权", async (t) => {
  const f = await fixture(
    t,
    '<input type="file" hidden id="file"><button onclick="document.querySelector(\'#file\').click()">添加附件</button>',
  );
  await writeFile(join(f.root, "file.txt"), "上传内容");
  const first = await f.observe();
  const clicked = await f.run({ action: "click", ...ref(first.observation, "添加附件") });
  assert.equal(clicked.tabs[0].file_chooser, true);
  const uploaded = await f.run({ action: "choose_files", page: f.id, paths: ["file.txt"] });
  assert.equal(uploaded.outcome, "executed");
  assert.equal(
    await f.page.locator("input").evaluate((element) => element.files[0].name),
    "file.txt",
  );
});

test("长正文按 Unicode 字符分页，后半部分不会因观察截断而丢失", async (t) => {
  const content = "中文😀".repeat(12000) + "末尾证据";
  const f = await fixture(t, `<main>${content}</main>`);
  let offset = 0;
  let text = "";
  for (;;) {
    const result = await f.run({ action: "read", page: f.id, offset });
    assert.equal(result.outcome, "observed");
    text += result.text_page.text;
    if (result.text_page.next_offset === null) break;
    offset = result.text_page.next_offset;
  }
  assert.ok(text.endsWith(content));
});

test("无关画布重绘不应阻止截图中位置和语义都未改变的控件点击", async (t) => {
  const f = await fixture(
    t,
    '<canvas width="200" height="100"></canvas><button onclick="document.body.dataset.clicked=1">稳定按钮</button>',
  );
  const first = await f.run({ action: "screenshot", page: f.id });
  const bounds = await f.page.locator("button").boundingBox();
  await f.page.locator("canvas").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    context.fillStyle = "red";
    context.fillRect(0, 0, 200, 100);
  });
  const result = await f.run({
    action: "pointer",
    page: f.id,
    observation: first.observation.id,
    x: Math.floor(bounds.x + bounds.width / 2),
    y: Math.floor(bounds.y + bounds.height / 2),
    button: "left",
    clicks: 1,
  });
  assert.equal(result.outcome, "executed");
  assert.equal(await f.page.locator("body").getAttribute("data-clicked"), "1");
});

test("参数语义校验失败不会销毁当前浏览器会话", async (t) => {
  const f = await fixture(t, "<button>保留页面</button>");
  const result = await f.engine.dispatch(
    { action: "press", page: f.id, observation: "old", key: "x".repeat(101) },
    new AbortController().signal,
    5000,
  );
  assert.equal(result.outcome, "not_executed");
  const observation = await f.observe();
  assert.equal(observation.outcome, "observed");
  assert.match(observation.observation.text, /保留页面/);
});

test("下拉选项可按可见标签选择，不要求模型猜测隐藏的 value", async (t) => {
  const f = await fixture(
    t,
    '<label>配送方式<select><option value="opaque-a">标准配送</option><option value="opaque-b">次日送达</option></select></label>',
  );
  const first = await f.observe();
  const selected = await f.run(
    { action: "select", ...ref(first.observation, "配送方式"), values: ["次日送达"] },
    new AbortController().signal,
    500,
  );
  assert.equal(selected.outcome, "executed");
  assert.equal(await f.page.locator("select").inputValue(), "opaque-b");
});

test("等待文字覆盖子框架中的异步状态", async (t) => {
  const f = await fixture(
    t,
    "<iframe srcdoc=\"<p>处理中</p><script>setTimeout(()=>document.querySelector('p').textContent='处理完成',150)</script>\"></iframe>",
  );
  const result = await f.run(
    { action: "wait", page: f.id, text: "处理完成", state: "visible" },
    new AbortController().signal,
    700,
  );
  assert.equal(result.outcome, "observed");
  assert.match(result.observation.text, /处理完成/);
});

test("等待文字隐藏必须确认所有同名匹配都已隐藏", async (t) => {
  const f = await fixture(
    t,
    "<p hidden>处理中</p><p id=\"active\">处理中</p><script>setTimeout(()=>document.querySelector('#active').remove(),500)</script>",
  );
  const result = await f.run({ action: "wait", page: f.id, text: "处理中", state: "hidden" });
  assert.equal(result.outcome, "observed");
  assert.equal(await f.page.locator("#active").count(), 0);
});

test("等待和查找默认精确匹配，不把任务说明里提及的文字当成目标", async (t) => {
  const f = await fixture(
    t,
    "<p>请等待“表单已就绪”，然后找到 INV-057。</p><p id=\"status\">加载中</p><div style=\"margin-top:1000px\">INV-057</div><script>setTimeout(()=>document.querySelector('#status').textContent='表单已就绪',500)</script>",
  );
  const waited = await f.run({ action: "wait", page: f.id, text: "表单已就绪", state: "visible" });
  assert.equal(waited.outcome, "observed");
  assert.equal(await f.page.locator("#status").innerText(), "表单已就绪");
  const found = await f.run({ action: "find", page: f.id, text: "INV-057" });
  assert.equal(found.outcome, "executed");
  assert.ok(await f.page.evaluate(() => scrollY > 0));
});

test("确认框后异步出现第二个弹窗时，观察不能挂死或丢失后续控制权", async (t) => {
  const f = await fixture(
    t,
    "<button onclick=\"if(confirm('继续？'))setTimeout(()=>alert('完成'),5)\">开始</button>" +
      "<label>字段<input></label>".repeat(60),
  );
  const first = await f.observe();
  await f.run({ action: "click", ...ref(first.observation, "开始") });
  const accepted = await Promise.race([
    f.run({ action: "dialog", page: f.id, accept: true }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("弹窗期间观察挂死")), 4000);
      timer.unref();
    }),
  ]);
  assert.equal(accepted.tabs[0].dialog?.type, "alert");
  const finished = await f.run({ action: "dialog", page: f.id, accept: true });
  assert.equal(finished.outcome, "executed");
  assert.equal(finished.tabs[0].dialog, null);
});

test("同一稳定表单能一次完成批量操作，并返回逐步回执", async (t) => {
  const f = await fixture(
    t,
    '<label>姓名<input></label><label>发票<input type="checkbox"></label><button onclick="document.body.dataset.saved=document.querySelector(\'input\').value">保存</button>',
  );
  const first = await f.observe();
  const observation = first.observation;
  const result = await f.engine.dispatch(
    {
      action: "batch",
      page: f.id,
      observation: observation.id,
      steps: [
        { action: "fill", ref: ref(observation, "姓名").ref, text: "批量用户" },
        { action: "check", ref: ref(observation, "发票").ref, checked: true },
        { action: "click", ref: ref(observation, "保存").ref },
      ],
    },
    new AbortController().signal,
    5000,
  );
  assert.equal(result.outcome, "executed");
  assert.deepEqual(
    result.steps.map((step) => step.outcome),
    ["executed", "executed", "executed"],
  );
  assert.equal(await f.page.locator("body").getAttribute("data-saved"), "批量用户");
});

test("批量操作中页面重绘时停止后续步骤，并保留已经执行的事实", async (t) => {
  const f = await fixture(
    t,
    "<button onclick=\"document.body.dataset.first=1;document.querySelector('#target').outerHTML='<button id=target onclick=window.wrong=true>替换后的按钮</button>'\">第一步</button><button id=\"target\">第二步</button>",
  );
  const first = await f.observe();
  const observation = first.observation;
  const result = await f.engine.dispatch(
    {
      action: "batch",
      page: f.id,
      observation: observation.id,
      steps: [
        { action: "click", ref: ref(observation, "第一步").ref },
        { action: "click", ref: ref(observation, "第二步").ref },
      ],
    },
    new AbortController().signal,
    5000,
  );
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(
    result.steps.map((step) => step.outcome),
    ["executed", "not_executed"],
  );
  assert.equal(await f.page.evaluate(() => window.wrong), undefined);
  assert.equal(await f.page.locator("body").getAttribute("data-first"), "1");
});

test("观察期间子框架完成导航时重新采集，只返回同一代页面的控件", async (t) => {
  const f = await fixture(t, "<label>字段<input></label>".repeat(80));
  await f.page.evaluate(() =>
    setTimeout(() => {
      const frame = document.createElement("iframe");
      frame.srcdoc = "<p>新增框架内容</p>";
      document.body.prepend(frame);
    }, 20),
  );
  const observed = await f.observe();
  assert.equal(observed.outcome, "observed");
  assert.match(observed.observation.text, /新增框架内容/);
});

test("截图后出现同位置遮挡层时，不能把坐标点击发送给新目标", async (t) => {
  const f = await fixture(
    t,
    '<button style="position:absolute;left:50px;top:50px;width:120px;height:50px">保存</button><button id="overlay" style="position:absolute;left:50px;top:50px;width:120px;height:50px;opacity:0;pointer-events:none;z-index:5" onclick="window.wrong=true">删除</button>',
  );
  const first = await f.run({ action: "screenshot", page: f.id });
  await f.page.locator("#overlay").evaluate((element) => {
    element.style.opacity = "1";
    element.style.pointerEvents = "auto";
  });
  const result = await f.run({
    action: "pointer",
    page: f.id,
    observation: first.observation.id,
    x: 100,
    y: 75,
    button: "left",
    clicks: 1,
  });
  assert.equal(result.outcome, "not_executed");
  assert.equal(await f.page.evaluate(() => window.wrong), undefined);
});

test("人工接管显示当前工作页，重复接管不能再抢走用户焦点", async (t) => {
  const f = await fixture(t, "<h1>第一页面</h1>");
  const second = await f.page.context().newPage();
  await second.setContent("<h1>第二页面</h1>");
  const secondId = f.engine.tabs()[1].id;
  await f.run({ action: "observe", page: secondId });
  const activated = [];
  for (const [name, page] of [
    ["first", f.page],
    ["second", second],
  ]) {
    const bring = page.bringToFront.bind(page);
    page.bringToFront = async () => {
      activated.push(name);
      await bring();
    };
  }
  await f.run({ action: "handoff" });
  await f.run({ action: "handoff" });
  assert.deepEqual(activated, ["second"]);
});

test("选项标签和另一项 value 相同时，选择模式必须明确，不能选错数量", async (t) => {
  const f = await fixture(
    t,
    '<select aria-label="数量"><option value="2">1</option><option value="1">2</option></select>',
  );
  const first = await f.observe();
  const selected = await f.run({
    action: "select",
    ...ref(first.observation, "数量"),
    values: ["2"],
  });
  assert.equal(selected.outcome, "executed");
  assert.equal(await f.page.locator("select").inputValue(), "1");
  const explicit = await f.run({
    action: "select",
    ...ref(selected.observation, "数量"),
    values: ["2"],
    by: "value",
  });
  assert.equal(explicit.outcome, "executed");
  assert.equal(await f.page.locator("select").inputValue(), "2");
});

test("追加输入触发键盘事件，支持依赖 keyup 的网页控件", async (t) => {
  const f = await fixture(
    t,
    '<label>代码<input value="pre-" onkeyup="document.body.dataset.keys=String(Number(document.body.dataset.keys||0)+1)"></label>',
  );
  await f.page.locator("input").focus();
  await f.page.keyboard.press("End");
  await f.page.locator("body").evaluate((element) => {
    element.removeAttribute("data-keys");
  });
  const first = await f.observe();
  const result = await f.engine.dispatch(
    { action: "type", ...ref(first.observation, "代码"), text: "abc" },
    new AbortController().signal,
    5000,
  );
  assert.equal(result.outcome, "executed");
  assert.equal(await f.page.locator("input").inputValue(), "pre-abc");
  assert.equal(await f.page.locator("body").getAttribute("data-keys"), "3");
});

test("回车触发确认框时交回控制权，不等待到浏览器被回收", async (t) => {
  const f = await fixture(
    t,
    "<label>代码<input onkeydown=\"if(event.key==='Enter')confirm('确认提交？')\"></label>",
  );
  const first = await f.observe();
  const result = await Promise.race([
    f.run({ action: "press", ...ref(first.observation, "代码"), key: "Enter" }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("键盘操作被弹窗挂死")), 2500);
      timer.unref();
    }),
  ]);
  assert.equal(result.tabs[0].dialog?.type, "confirm");
});

test("用户在接管期间手动关闭弹窗后，交还可以继续观察页面", async (t) => {
  const f = await fixture(t, "<button onclick=\"confirm('确认提交？')\">提交</button>");
  const first = await f.observe();
  const manualDialog = f.page.waitForEvent("dialog");
  await f.run({ action: "click", ...ref(first.observation, "提交") });
  await f.run({ action: "handoff" });
  await (await manualDialog).dismiss();
  await f.run({ action: "resume" });
  const result = await f.observe();
  assert.equal(result.outcome, "observed");
  assert.equal(result.tabs[0].dialog, null);
});

test("输入过程中出现弹窗时停止剩余字符，关闭弹窗后也不能偷偷续写", async (t) => {
  const f = await fixture(
    t,
    "<label>代码<input oninput=\"if(this.value==='a')alert('暂停输入')\"></label>",
  );
  const first = await f.observe();
  const result = await f.run({ action: "type", ...ref(first.observation, "代码"), text: "abc" });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.tabs[0].dialog?.type, "alert");
  await f.run({ action: "dialog", page: f.id, accept: true });
  assert.equal(await f.page.locator("input").inputValue(), "a");
});

test("坐标双击遇到确认框时停止后续点击，不重复提交", async (t) => {
  const f = await fixture(
    t,
    '<button style="width:160px;height:60px" onclick="document.body.dataset.calls=String(Number(document.body.dataset.calls||0)+1);confirm(\'确认？\')">提交</button>',
  );
  const first = await f.run({ action: "screenshot", page: f.id });
  const result = await f.run({
    action: "pointer",
    page: f.id,
    observation: first.observation.id,
    x: 80,
    y: 30,
    button: "left",
    clicks: 2,
  });
  assert.equal(result.tabs[0].dialog?.type, "confirm");
  await f.run({ action: "dialog", page: f.id, accept: false });
  assert.equal(await f.page.locator("body").getAttribute("data-calls"), "1");
});

test("跨站子框架的弹窗同样可以观察和关闭", async (t) => {
  const f = await fixture(t, "<h1>初始页面</h1>");
  await f.observe();
  await f.page.context().route("https://*.example/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: route.request().url().includes("outer.example")
        ? '<iframe src="https://inner.example/dialog"></iframe>'
        : "<button onclick=\"confirm('跨域确认')\">跨域提交</button>",
    }),
  );
  await f.page.goto("https://outer.example/page");
  const first = await f.observe();
  const result = await f.run({ action: "click", ...ref(first.observation, "跨域提交") });
  assert.equal(result.tabs[0].dialog?.message, "跨域确认");
  const closed = await f.run({ action: "dialog", page: f.id, accept: false });
  assert.equal(closed.tabs[0].dialog, null);
});

test("上传保留文件 MIME 类型，图片控件不会把 PNG 误认为通用二进制", async (t) => {
  const f = await fixture(t, '<input type="file" aria-label="照片" accept="image/png">');
  await writeFile(
    join(f.root, "photo.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const first = await f.observe();
  const result = await f.run({
    action: "upload",
    ...ref(first.observation, "照片"),
    paths: ["photo.png"],
  });
  assert.equal(result.outcome, "executed");
  assert.equal(
    await f.page.locator("input").evaluate((element) => element.files[0].type),
    "image/png",
  );
});
