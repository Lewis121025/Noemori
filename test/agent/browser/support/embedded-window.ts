import { app, BrowserWindow, webContents, session } from "electron";
import { createInterface } from "node:readline";
import { BrowserWorkspace } from "../../../../modules/notes/packages/desktop/src/features/agent/main/browser-workspace";
import { record, text } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";
import { parseBrowserPlacement } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/browser";

const profile = process.env["NOEMORI_EMBEDDED_PROFILE"];
if (!profile) throw new Error("测试必须使用独立应用目录");
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
if (process.platform === "darwin") app.setActivationPolicy("accessory");

void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, backgroundThrottling: false } });
  const workspace = new BrowserWorkspace(window, "fixture", () => {});
  const partition = session.fromPartition("persist:noemori-browser-fixture");
  const setProxy = partition.setProxy.bind(partition);
  const proxyGate = Promise.withResolvers<void>();
  let firstProxy = true;
  partition.setProxy = async (options) => {
    if (firstProxy) {
      firstProxy = false;
      process.stdout.write(JSON.stringify({ kind: "proxy_wait" }) + "\n");
      await proxyGate.promise;
    }
    await setProxy(options);
  };
  await session.defaultSession.cookies.set({ url: "https://fixture.test", name: "app-only", value: "private" });
  await session.fromPartition("persist:noemori-browser-fixture").cookies.set({ url: "https://fixture.test", name: "browser-only", value: "shared-login" });
  await window.loadURL("data:text/html,<title>Noemori 浏览器验收</title><h1>窗口内浏览器</h1>");
  window.webContents.debugger.attach("1.3");
  const appInfo: unknown = await window.webContents.debugger.sendCommand("Target.getTargetInfo");
  const appTarget = text(record(record(appInfo)["targetInfo"]), "targetId");
  window.webContents.debugger.detach();
  process.stdout.write(JSON.stringify({ kind: "ready", lease: await workspace.ready, appTarget }) + "\n");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const command = record(JSON.parse(line));
    const id = command["id"];
    try {
      let result: unknown = null;
      if (command["action"] === "releaseProxy") proxyGate.resolve();
      else if (command["action"] === "contents") result = webContents.getAllWebContents().length;
      else if (command["action"] === "failNextCreate") {
        app.once("web-contents-created", (_event, contents) => {
          contents.loadURL = async () => { throw new Error("测试注入：页面初始化失败"); };
        });
      }
      else if (command["action"] === "show") {
        const placement = parseBrowserPlacement(command["placement"]);
        if (!placement) workspace.hide(); else workspace.show(text(command, "target"), placement);
      } else if (command["action"] === "downloads") result = workspace.listDownloads();
      else if (command["action"] === "input") {
        const target = text(command, "target");
        const contents = webContents.getAllWebContents();
        const matches = [];
        for (const candidate of contents) {
          if (candidate.debugger.isAttached()) {
            const info: unknown = await candidate.debugger.sendCommand("Target.getTargetInfo");
            if (record(record(info)["targetInfo"])["targetId"] === target) matches.push(candidate);
          }
        }
        if (matches.length !== 1) throw new Error("测试网页身份无效");
        const events = command["events"];
        if (!Array.isArray(events)) throw new Error("测试输入必须为数组");
        for (const value of events) {
          const event = record(value);
          if (event["type"] !== "mouseDown" && event["type"] !== "mouseUp") throw new Error("测试仅发送鼠标点击");
          if (typeof event["x"] !== "number" || typeof event["y"] !== "number") throw new Error("测试坐标无效");
          matches[0]!.sendInputEvent({ type: event["type"], x: event["x"], y: event["y"], button: "left", clickCount: 1 });
        }
      } else if (command["action"] === "close") {
        await workspace.close();
        const remaining = webContents.getAllWebContents().filter((contents) => contents !== window.webContents).length;
        window.destroy();
        process.stdout.write(JSON.stringify({ id, result: { status: "closed", remaining } }) + "\n");
        app.quit(); return;
      } else throw new Error("测试命令无效");
      process.stdout.write(JSON.stringify({ id, result }) + "\n");
    } catch (error) { process.stdout.write(JSON.stringify({ id, error: String(error) }) + "\n"); }
  }
  await workspace.close(); window.destroy(); app.quit();
}).catch((error: unknown) => { console.error(error); app.exit(1); });
