import http from "node:http";
import { pathToFileURL } from "node:url";

const instructions = {
  form: "填写姓名“林川”，选择地区“日本”和配送“次日送达”，勾选开具发票，然后提交。",
  frame: "等待子页面出现“表单已就绪”，在子页面内填写项目代号 NOTE-42 并提交。",
  list: "找到 INV-057，将该记录标记为已核对。其他记录不要操作。",
  dialog: "点击新增记录，确认对话框，然后关闭成功提示。",
  tabs: "打开详情页，取得校验码，回到原页面填写校验码并提交。",
  files: "下载测试附件，随后使用本页的上传按钮上传刚下载的文件，并提交验证。",
  canvas: "把画布中的蓝色块拖入绿色框。",
  navigation: "把列表筛选为“已完成”，等待筛选结果，打开 Beta 记录并确认。",
};

function document(title, body, script = "") {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>
  <style>body{font:18px system-ui;margin:30px;max-width:1000px}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:8px}button{cursor:pointer}table{border-collapse:collapse;width:100%}td,th{padding:12px;border-bottom:1px solid #ccc;text-align:left}iframe{width:800px;height:280px;border:1px solid #aaa}output{display:block;margin:20px 0;color:#075}canvas{border:1px solid #aaa;touch-action:none}</style>
  <h1>${title}</h1>${body}<output role="status" id="result"></output><script>${script}</script></html>`;
}

function recordScript(run, task) {
  return `async function report(value){const response=await fetch('/result?run=${run}&task=${task}',{method:'POST',body:JSON.stringify(value)});const result=await response.json();document.querySelector('#result').textContent=result.passed?'验收通过':'验收失败';}`;
}

function page(task, run) {
  const goal = `<p>${instructions[task]}</p>`;
  const report = recordScript(run, task);
  switch (task) {
    case "form":
      return document(
        "表单任务",
        goal +
          `<form><label>姓名<input name="name"></label><label>地区<select name="country"><option value="q-1">中国</option><option value="q-7">日本</option></select></label><label>配送<select name="shipping"><option value="s-3">标准配送</option><option value="s-9">次日送达</option></select></label><label><input type="checkbox" name="invoice">开具发票</label><button>提交</button></form>`,
        report +
          `document.querySelector('form').onsubmit=e=>{e.preventDefault();report(Object.fromEntries(new FormData(e.target)))}`,
      );
    case "frame":
      return document(
        "子框架任务",
        goal + `<iframe title="项目登记" src="/inner?run=${run}"></iframe>`,
      );
    case "list":
      return document(
        "长列表任务",
        goal +
          `<table><thead><tr><th>编号</th><th>金额</th><th>操作</th></tr></thead><tbody>${Array.from(
            { length: 80 },
            (_, i) => {
              const id = "INV-" + String(i + 1).padStart(3, "0");
              return `<tr><td>${id}</td><td>${(i + 1) * 17}</td><td><button data-id="${id}">标记已核对</button></td></tr>`;
            },
          ).join("")}</tbody></table>`,
        report +
          `document.querySelectorAll('button').forEach(button=>button.onclick=()=>report({id:button.dataset.id}));`,
      );
    case "dialog":
      return document(
        "对话框任务",
        goal + "<button>新增记录</button>",
        report +
          `document.querySelector('button').onclick=async()=>{if(confirm('确认新增这条测试记录？')){alert('记录已新增');await report({confirmed:true})}};`,
      );
    case "tabs":
      return document(
        "多标签任务",
        goal +
          `<a href="/detail?run=${run}" target="_blank">打开详情页</a><form><label>校验码<input name="code"></label><button>提交</button></form>`,
        report +
          `document.querySelector('form').onsubmit=e=>{e.preventDefault();report(Object.fromEntries(new FormData(e.target)))}`,
      );
    case "files":
      return document(
        "文件任务",
        goal +
          '<a href="/attachment">下载测试附件</a><input type="file" id="file" hidden><button id="choose">上传附件</button><button id="submit">提交验证</button>',
        report +
          `document.querySelector('#choose').onclick=()=>document.querySelector('#file').click();document.querySelector('#submit').onclick=async()=>{const file=document.querySelector('#file').files[0];await report({text:file?await file.text():''})};`,
      );
    case "canvas":
      return document(
        "视觉拖拽任务",
        goal + '<canvas width="600" height="240"></canvas>',
        report +
          `const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let down=false,x=70,y=80;function draw(){ctx.clearRect(0,0,600,240);ctx.fillStyle='#c9f2d6';ctx.fillRect(430,70,100,100);ctx.strokeStyle='#187638';ctx.strokeRect(430,70,100,100);ctx.fillStyle='#1769df';ctx.fillRect(x,y,70,70)}draw();canvas.onpointerdown=e=>{const r=canvas.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;if(px>=x&&px<x+70&&py>=y&&py<y+70){down=true;canvas.setPointerCapture(e.pointerId)}};canvas.onpointermove=e=>{if(down){const r=canvas.getBoundingClientRect();x=e.clientX-r.left-35;y=e.clientY-r.top-35;draw()}};canvas.onpointerup=()=>{if(down){down=false;if(x>=420&&x<=500&&y>=60&&y<=120)report({dropped:true})}};`,
      );
    case "navigation":
      return document(
        "动态筛选任务",
        goal + '<button id="filter">已完成</button><section id="rows">当前显示全部记录</section>',
        report +
          `document.querySelector('#filter').onclick=()=>{history.pushState({},'',location.pathname+location.search+'&status=done');document.querySelector('#rows').textContent='加载中';setTimeout(()=>{document.querySelector('#rows').innerHTML='<button id="beta">Beta</button>';document.querySelector('#beta').onclick=()=>{document.querySelector('#rows').innerHTML='<h2>Beta 记录</h2><button id="confirm">确认</button>';document.querySelector('#confirm').onclick=()=>report({record:'Beta',status:'done'})}},300)};`,
      );
    default:
      return null;
  }
}

function verify(task, value) {
  switch (task) {
    case "form":
      return (
        value.name === "林川" &&
        value.country === "q-7" &&
        value.shipping === "s-9" &&
        value.invoice === "on"
      );
    case "frame":
      return value.code === "NOTE-42";
    case "list":
      return value.id === "INV-057";
    case "dialog":
      return value.confirmed === true;
    case "tabs":
      return value.code === "BENCH-42";
    case "files":
      return value.text === "browser-use-benchmark:42\n";
    case "canvas":
      return value.dropped === true;
    case "navigation":
      return value.record === "Beta" && value.status === "done";
    default:
      return false;
  }
}

/** 在随机本机端口提供可重复的验收场景；成功由服务器核验，不依赖 Agent 自称完成。 */
export async function startBenchmarkSite() {
  const results = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const run = url.searchParams.get("run");
    if (url.pathname === "/results") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Object.fromEntries(results)));
      return;
    }
    if (url.pathname === "/attachment") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename=benchmark.txt",
      });
      response.end("browser-use-benchmark:42\n");
      return;
    }
    if (run !== "codex" && run !== "project") {
      response.writeHead(400);
      response.end("请选择测试运行");
      return;
    }
    if (url.pathname === "/result" && request.method === "POST") {
      const task = url.searchParams.get("task");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let passed = false;
      try {
        passed = verify(task, JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        /* 无效测试提交也计为失败，不中断验收服务。 */
      }
      const key = `${run}/${task}`;
      const previous = results.get(key);
      results.set(key, {
        passed: passed && (!previous || previous.passed),
        submissions: (previous?.submissions || 0) + 1,
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ passed }));
      return;
    }
    let html;
    if (url.pathname === "/inner")
      html = document(
        "项目登记",
        '<p>加载中</p><div id="host"></div>',
        recordScript(run, "frame") +
          `setTimeout(()=>{document.querySelector('p').textContent='表单已就绪';document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<label>项目代号<input></label><button>提交项目</button>';const root=document.querySelector('#host').shadowRoot;root.querySelector('button').onclick=()=>report({code:root.querySelector('input').value})},350)`,
      );
    else if (url.pathname === "/detail") html = document("记录详情", "<p>校验码：BENCH-42</p>");
    else html = page(url.pathname.slice(1), run);
    response.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(html || "没有此场景");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const site = await startBenchmarkSite();
  console.log(site.origin);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void site.close().then(() => process.exit(0));
    });
}
