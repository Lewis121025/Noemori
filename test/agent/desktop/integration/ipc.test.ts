import { beforeEach, expect, it, vi } from "vitest";
import { BrowserWindow, ipcMain } from "electron";
import { registerAgentIpc } from "../../../../modules/notes/packages/desktop/src/features/agent/main/ipc";
import { AgentService } from "../../../../modules/notes/packages/desktop/src/features/agent/main/service";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProviderModel } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";

const transport = vi.hoisted(() => ({
  destroyed: false,
  loading: false,
  root: null as string | null,
}));
vi.mock("../../../../modules/notes/packages/desktop/src/features/agent/main/service", () => ({
  AgentService: class {
    settingsGet = vi.fn();
    providersGet = vi.fn();
    providersSave = vi.fn();
    providersRemove = vi.fn();
    modelSelect = vi.fn();
    start = vi.fn();
    terminalInput = vi.fn();
    create = vi.fn();
    attachVault = vi.fn();
  },
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = {
      mainFrame: {},
      isDestroyed: () => transport.destroyed,
      isLoadingMainFrame: () => transport.loading,
    };
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
let window: BrowserWindow | null;
let service: AgentService;
const handlers = new Map<string, (...args: unknown[]) => unknown>();
beforeEach(() => {
  vi.clearAllMocks();
  transport.loading = false;
  transport.destroyed = false;
  transport.root = null;
  window = new BrowserWindow();
  service = new AgentService("/state", "/launcher", () => {});
  handlers.clear();
  vi.mocked(ipcMain.handle).mockImplementation((name, handler) => {
    handlers.set(name, (...args) =>
      handler(args[0] as Electron.IpcMainInvokeEvent, ...args.slice(1)),
    );
  });
  registerAgentIpc(
    () => window,
    () => service,
    async () => transport.root,
  );
});

it("文章库归属按真实目录核对，系统路径别名不能被误判为另一个库", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-article-root-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const actual = join(directory, "vault"),
    alias = join(directory, "alias");
  await mkdir(actual);
  await symlink(actual, alias, "dir");
  transport.root = alias;
  const canonical = await realpath(actual);
  await call("agent.attachVault", event(), canonical);
  expect(service.attachVault).toHaveBeenCalledWith(canonical);
  await expect(call("agent.attachVault", event(), directory)).rejects.toThrow("笔记库已改变");
});
function event() {
  const contents = window?.webContents;
  if (!contents) throw new Error("窗口不存在");
  return { sender: contents, senderFrame: contents.mainFrame };
}
function call(name: string, ...args: unknown[]) {
  const handler = handlers.get(name);
  if (!handler) throw new Error("入口缺失");
  return handler(...args);
}

it("Agent 请求只接受当前主窗口主框架", () => {
  const current = event();
  call("agent.settingsGet", current);
  expect(service.settingsGet).toHaveBeenCalledOnce();
  for (const wrong of [
    { ...current, sender: {} },
    { ...current, senderFrame: {} },
  ])
    expect(() => call("agent.start", wrong, "session", "任务")).toThrow("主窗口");
  transport.loading = true;
  expect(() => call("agent.start", current, "session", "任务")).toThrow("主窗口");
  transport.loading = false;
  transport.destroyed = true;
  expect(() => call("agent.start", current, "session", "任务")).toThrow("主窗口");
  transport.destroyed = false;
  window = new BrowserWindow();
  expect(() => call("agent.start", current, "session", "任务")).toThrow("主窗口");
  window = null;
  expect(() => call("agent.start", current, "session", "任务")).toThrow("主窗口");
  expect(service.start).not.toHaveBeenCalled();
});

it("供应商管理动作验证窗口归属、独立身份和模型列表后才进入服务", () => {
  const current = event();
  const provider = { id: null, name: "本地服务", protocol: "openai-chat", address: { type: "base_url", url: "http://127.0.0.1:1234/v1" }, authentication: { type: "none" }, models: [newProviderModel("fixture")] };
  call("agent.providersGet", current);
  call("agent.providersSave", current, provider);
  call("agent.modelSelect", current, { providerId: "saved", modelId: "fixture" });
  expect(service.providersGet).toHaveBeenCalledOnce();
  expect(service.providersSave).toHaveBeenCalledWith(provider);
  expect(service.modelSelect).toHaveBeenCalledWith({ providerId: "saved", modelId: "fixture" });
  expect(() => call("agent.providersSave", { ...current, senderFrame: {} }, provider)).toThrow("主窗口");
  expect(() => call("agent.providersSave", current, { ...provider, models: [] })).toThrow("模型");
  expect(() => call("agent.modelSelect", current, { providerId: "", modelId: "fixture" })).toThrow("模型");
  expect(() => call("agent.providersRemove", current, "")).toThrow("标识");
  expect(service.providersSave).toHaveBeenCalledOnce();
  expect(service.providersRemove).not.toHaveBeenCalled();
});

it("错误输入和超预算字节在进入原生层前被拒绝", () => {
  const current = event();
  expect(() => call("agent.start", current, "", "任务")).toThrow("标识");
  expect(() =>
    call("agent.terminalInput", current, "session", "terminal", new Uint8Array(16385)),
  ).toThrow("16 KiB");
  expect(() => call("agent.terminalInput", current, "session", "terminal", "input")).toThrow(
    "输入",
  );
  expect(service.terminalInput).not.toHaveBeenCalled();
  const data = new Uint8Array([0, 255, 3]);
  call("agent.terminalInput", current, "session", "terminal", data);
  expect(service.terminalInput).toHaveBeenCalledWith("session", "terminal", data);
});
