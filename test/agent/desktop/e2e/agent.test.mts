import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { openSettings } from "../../../notes/desktop/support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("实际窗口审批、终端输入与重载恢复使用同一原生会话", async (context) => {
  const root=await mkdtemp(join(tmpdir(),"noemori-agent-desktop-"));context.onTestFinished(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,"workspace");const state=join(root,"state");await Promise.all([mkdir(workspace),mkdir(state)]);
  const secret=join(root,"secret");await writeFile(secret,"fixture-secret");
  let calls=0;
  const server=createServer(async(input,output)=>{
    for await(const _piece of input){/* 请求读取完再交付完整协议响应。 */}
    calls+=1;
    const message=calls===1?{role:"assistant",content:null,tool_calls:[{id:"interactive",type:"function",function:{name:"terminal",arguments:JSON.stringify({action:"exec",cmd:`printf ready; read value; printf 'received:%s\n' "$value"; sleep 30`,tty:true,yield_time_ms:0,permission_request:{reason:"读取外部测试文件",readable_paths:[secret]}})}}]}:{role:"assistant",content:"终端已就绪"};
    output.writeHead(200,{"content-type":"application/json"});output.end(JSON.stringify({id:`desktop-${calls}`,choices:[{index:0,message,finish_reason:calls===1?"tool_calls":"stop"}]}));
  });
  await new Promise<void>((done)=>server.listen(0,"127.0.0.1",done));context.onTestFinished(()=>new Promise<void>((done)=>server.close(()=>done())));
  const address=server.address();if(!address||typeof address!=="object")throw new Error("模型 fixture 未监听");
  const executable:unknown=require("electron");if(typeof executable!=="string")throw new Error("Electron 未安装");
  const app=await electron.launch({executablePath:executable,args:[fileURLToPath(new URL("out/main/index.js",desktop)),`--user-data-dir=${state}`],cwd:fileURLToPath(desktop),env:{...process.env,NOEMORI_TEST_WINDOW:"hidden"}});
  const page=await app.firstWindow();await page.waitForLoadState("load");await page.waitForFunction(()=>typeof window.noemori?.agent?.list==="function");
  await page.evaluate(async(endpoint)=>{await window.noemori.agent.settingsSet({protocol:"openai-chat",model:"fixture",endpoint,authentication:{type:"none"},tools:true,streaming:false,vision:false,audio:false,video:false});},`http://127.0.0.1:${address.port}/chat`);
  await app.evaluate(({dialog},workspace)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});},workspace);
  await openSettings(page);await page.getByRole("button",{name:"工作区助手",exact:true}).click();
  await page.getByRole("button",{name:"新会话",exact:true}).click();await page.getByRole("textbox",{name:"Agent 用户任务"}).fill("打开终端");await page.getByRole("button",{name:"发送",exact:true}).click();
  await page.locator(".approval").waitFor();
  expect(await page.locator(".approval").textContent()).toContain("读取外部测试文件");
  await page.getByRole("button",{name:"批准本次",exact:true}).click();
  await expect.poll(() => page.evaluate(async()=>{const sessions=await window.noemori.agent.list();return sessions[0]?.run?.status==="completed"&&sessions[0].terminals[0]?.bytes>0;}), { timeout: 15000 }).toBe(true);
  const before=await page.evaluate(async()=>{const sessions=await window.noemori.agent.list();return sessions[0]?.id;});if(!before)throw new Error("会话未创建");
  await page.locator(".terminal-screen").click();await page.keyboard.type("line");await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(async()=>{const session=(await window.noemori.agent.list())[0];if(!session)return false;const terminal=session.terminals[0];if(!terminal)return false;const page=await window.noemori.agent.terminalRead(session.id,terminal.process.session_id,"0");return page.chunks.some((chunk)=>atob(chunk.data_base64).includes("received:line"));}), { timeout: 15000 }).toBe(true);
  await page.reload();await page.waitForLoadState("load");await page.waitForFunction(()=>typeof window.noemori?.agent?.list==="function");
  const restored=await page.evaluate(async()=>{const sessions=await window.noemori.agent.list();return {id:sessions[0]?.id,count:sessions[0]?.terminals.length};});expect(restored).toEqual({id:before,count:1});
  await openSettings(page);await page.getByRole("button",{name:"工作区助手",exact:true}).click();
  await page.getByRole("button",{name:"停止",exact:true}).click();
  await expect.poll(() => page.evaluate(async()=>{const session=(await window.noemori.agent.list())[0];return session?.terminals.every((terminal)=>terminal.process.status!=="running");}), { timeout: 15000 }).toBe(true);
  await page.getByRole("button",{name:"结束会话",exact:true}).click();expect(await page.evaluate(()=>window.noemori.agent.list())).toEqual([]);
  await app.close();
});
