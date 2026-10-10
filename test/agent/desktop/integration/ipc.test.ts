import { beforeEach, expect, it, vi } from "vitest";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { registerAgentIpc } from "../../../../modules/notes/packages/desktop/src/features/agent/main/ipc";
import { AgentService } from "../../../../modules/notes/packages/desktop/src/features/agent/main/service";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, truncate } from "node:fs/promises";
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
    providersDiscover = vi.fn();
    providersRefresh = vi.fn();
    providersSave = vi.fn();
    providersRemove = vi.fn();
    modelSelect = vi.fn();
    start = vi.fn();
    steer = vi.fn();
    queueGet = vi.fn();
    queueAdd = vi.fn();
    queueRemove = vi.fn();
    queuePause = vi.fn();
    terminalInput = vi.fn();
    create = vi.fn();
    list = vi.fn(async () => ({ items: [], issues: [] }));
    attachVault = vi.fn();
    addAttachments = vi.fn(async () => []);
    contentPreview = vi.fn();
    attachmentContent = vi.fn();
    saveDraft = vi.fn();
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
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
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

it("笔记库文件附件只读取当前库内普通文件，拒绝越界、目录、过期库和超限文件", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-library-attachment-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory), vault = join(root, "vault");
  await mkdir(vault);
  transport.root = vault;
  await writeFile(join(vault, "资料.md"), "正文😀");
  await writeFile(join(root, "outside.txt"), "不可读取");
  await symlink(join(root, "outside.txt"), join(vault, "escape.txt"));
  const request = (path: string, kind = "file") => ({ root: vault, entries: [{ path, kind }] });
  await call("agent.attachmentsFromLibrary", event(), "session", request("资料.md"));
  const [owner, files] = vi.mocked(service.addAttachments).mock.calls[0]!;
  expect(owner).toBe("session");
  expect(files[0]!.name).toBe("资料.md");
  expect(Array.from(files[0]!.bytes)).toEqual(Array.from(new TextEncoder().encode("正文😀")));
  vi.mocked(service.addAttachments).mockClear();
  for (const value of [request("../outside.txt"), request("escape.txt"), request("資料", "directory"), { ...request("资料.md"), root }])
    await expect(call("agent.attachmentsFromLibrary", event(), "session", value)).rejects.toThrow();
  await writeFile(join(vault, "large.txt"), "");
  await truncate(join(vault, "large.txt"), 25 * 1024 * 1024 + 1);
  await expect(call("agent.attachmentsFromLibrary", event(), "session", request("large.txt"))).rejects.toThrow("25 MiB");
  await expect(call("agent.attachmentsFromLibrary", event(), "session", { root: vault, entries: Array.from({ length: 9 }, (_, index) => ({ path: `${index}.txt`, kind: "file" })) })).rejects.toThrow("八个");
  expect(service.addAttachments).not.toHaveBeenCalled();
});

it("草稿 IPC 保留缺省附件语义，显式空列表才清空附件", () => {
  call("agent.saveDraft", event(), "session", "继续输入", []);
  expect(service.saveDraft).toHaveBeenLastCalledWith("session", "继续输入", [], undefined);
  call("agent.saveDraft", event(), "session", "移除附件", [], []);
  expect(service.saveDraft).toHaveBeenLastCalledWith("session", "移除附件", [], []);
});

it("Agent 请求只接受当前主窗口主框架", () => {
  const current = event();
  call("agent.settingsGet", current, "session");
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

it("新建对话可以不关联目录，空目录不会被当作已确认的路径", async () => {
  await call("agent.create", event(), null, "独立对话");
  expect(service.create).toHaveBeenCalledWith(null, "独立对话");
  await expect(call("agent.create", event(), "", "无效关联")).rejects.toThrow("工作目录");
  expect(service.create).toHaveBeenCalledOnce();
});

it("目录选择入口打开系统选择器，取消不创建对话，选中后返回规范路径", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-directory-picker-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await call("agent.pickWorkspace", event())).toBeNull();
  expect(dialog.showOpenDialog).toHaveBeenCalledWith(
    window,
    expect.objectContaining({ properties: ["openDirectory"] }),
  );
  expect(service.create).not.toHaveBeenCalled();
  const folder = join(directory, "folder"),
    alias = join(directory, "alias");
  await mkdir(folder);
  await symlink(folder, alias, "dir");
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
    canceled: false,
    filePaths: [alias],
  });
  const selected = await call("agent.pickWorkspace", event());
  expect(selected).toBe(await realpath(folder));
  await call("agent.create", event(), selected, "关联对话");
  expect(service.create).toHaveBeenCalledWith(selected, "关联对话");
  await call("agent.create", event(), alias, "目录别名");
  expect(service.create).toHaveBeenCalledWith(selected, "目录别名");
});

it("供应商管理动作验证窗口归属、独立身份和模型列表后才进入服务", () => {
  const current = event();
  const provider = {
    id: null,
    name: "本地服务",
    protocol: "openai-chat",
    address: { type: "base_url", url: "http://127.0.0.1:1234/v1" },
    authentication: { type: "none" },
    models: [newProviderModel("fixture")],
  };
  call("agent.providersGet", current);
  call("agent.providersRefresh", current, "saved");
  expect(service.providersRefresh).toHaveBeenCalledWith("saved");
  call("agent.providersSave", current, provider);
  call("agent.modelSelect", current, "session", { providerId: "saved", modelId: "fixture" });
  expect(service.providersGet).toHaveBeenCalledOnce();
  expect(service.providersSave).toHaveBeenCalledWith(provider);
  expect(service.modelSelect).toHaveBeenCalledWith("session", {
    providerId: "saved",
    modelId: "fixture",
  });
  expect(() => call("agent.providersSave", { ...current, senderFrame: {} }, provider)).toThrow(
    "主窗口",
  );
  expect(() =>
    call("agent.providersSave", current, { ...provider, models: [newProviderModel("")] }),
  ).toThrow("模型");
  expect(() =>
    call("agent.modelSelect", current, "session", { providerId: "", modelId: "fixture" }),
  ).toThrow("模型");
  expect(() => call("agent.providersRemove", current, "")).toThrow("标识");
  expect(service.providersSave).toHaveBeenCalledOnce();
  expect(service.providersRemove).not.toHaveBeenCalled();
});

it("模型发现无需名称和模型 ID，但必须先验证连接和窗口归属", () => {
  const current = event();
  const connection = {
    id: null,
    protocol: "openai-chat",
    address: { type: "base_url", url: "https://example.com/v1" },
    authentication: { type: "bearer", value: "secret" },
  };
  call("agent.providersDiscover", current, connection);
  expect(service.providersDiscover).toHaveBeenCalledWith(connection);
  expect(() =>
    call("agent.providersDiscover", { ...current, senderFrame: {} }, connection),
  ).toThrow("主窗口");
  expect(() =>
    call("agent.providersDiscover", current, { ...connection, authentication: null }),
  ).toThrow("认证");
  expect(() =>
    call("agent.providersDiscover", current, {
      ...connection,
      address: { type: "base_url", url: "file:///tmp/models" },
    }),
  ).toThrow("HTTP");
  expect(service.providersDiscover).toHaveBeenCalledOnce();
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

it("补充与追问校验运行身份、窗口归属和 UTF-8 字节上限，不改写原文", () => {
  const current = event(), text = "  分两步\n执行这项任务  ";
  call("agent.steer", current, "session", "active", text);
  call("agent.queueAdd", current, "session", "active", text);
  call("agent.queueGet", current, "session");
  call("agent.queueRemove", current, "session", "pending");
  call("agent.queuePause", current, "session", true);
  expect(service.steer).toHaveBeenCalledWith("session", "active", text, [], []);
  expect(service.queueAdd).toHaveBeenCalledWith("session", "active", text, [], []);
  expect(service.queuePause).toHaveBeenCalledWith("session", true);
  for (const channel of ["agent.steer", "agent.queueAdd"]) {
    expect(() => call(channel, current, "session", "", text)).toThrow("标识");
    expect(() => call(channel, current, "session", "active", "中".repeat(45000))).toThrow("128 KiB");
    expect(() => call(channel, current, "session", "active", "  ")).toThrow("用户输入无效");
    expect(() => call(channel, { ...current, senderFrame: {} }, "session", "active", text)).toThrow("主窗口");
  }
  expect(() => call("agent.queuePause", current, "session", "false")).toThrow("暂停");
  expect(service.steer).toHaveBeenCalledOnce();
  expect(service.queueAdd).toHaveBeenCalledOnce();
});

it("统一目录新建对话接受当前库的真实文件夹，越界目录仍需显式选择", async (test) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "noemori-chat-workspace-")));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "vault"),
    child = join(root, "notes"),
    outside = join(directory, "vault-other");
  await mkdir(child, { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(root, "alias"), "dir");
  transport.root = root;
  await call("agent.create", event(), root, "库内讨论");
  await call("agent.create", event(), child, "目录讨论");
  expect(service.create).toHaveBeenCalledWith(root, "库内讨论");
  expect(service.create).toHaveBeenCalledWith(child, "目录讨论");
  await expect(call("agent.create", event(), outside, "外部")).rejects.toThrow("选择器");
  await expect(call("agent.create", event(), join(root, "alias"), "越界别名")).rejects.toThrow(
    "选择器",
  );
  expect(service.create).toHaveBeenCalledTimes(2);
});

it("内容预览验证会话和窗口归属，隔离网页不能读取工作区文件", () => {
  const current = event();
  call("agent.contentPreview", current, "session", "报告.pdf");
  expect(service.contentPreview).toHaveBeenCalledWith("session", "报告.pdf");
  expect(() => call("agent.contentPreview", { ...current, senderFrame: {} }, "session", "报告.pdf")).toThrow("主窗口");
  expect(() => call("agent.contentPreview", current, "", "报告.pdf")).toThrow("标识");
  expect(() => call("agent.contentPreview", current, "session", null)).toThrow();
  expect(service.contentPreview).toHaveBeenCalledOnce();
});

it("保存写入读取时的完整字节，取消和选择期间窗口改变不会覆盖已有文件", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-content-save-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "保存.pdf"), current = event();
  const file = { name: "报告.pdf", bytes: new Uint8Array([0, 255, 10, 3]) };
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: path });
  expect(await call("agent.contentSave", current, file)).toBe(true);
  expect(await readFile(path)).toEqual(Buffer.from(file.bytes));
  expect(dialog.showSaveDialog).toHaveBeenCalledWith(window, expect.objectContaining({ defaultPath: file.name, properties: ["showOverwriteConfirmation"] }));

  const changed = { ...file, bytes: new Uint8Array([1]) };
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: path });
  expect(await call("agent.contentSave", current, changed)).toBe(false);
  expect(await readFile(path)).toEqual(Buffer.from(file.bytes));
  vi.mocked(dialog.showSaveDialog).mockImplementationOnce(async () => {
    window = new BrowserWindow();
    return { canceled: false, filePath: path };
  });
  await expect(call("agent.contentSave", current, changed)).rejects.toThrow("主窗口");
  expect(await readFile(path)).toEqual(Buffer.from(file.bytes));
});

it("附件保存按所属会话读取原始副本，完整性失败不会弹出保存选择器", async () => {
  const file = { name: "原图.png", bytes: new Uint8Array([0, 255, 3]) };
  const attachment = "11111111-1111-4111-8111-111111111111";
  vi.mocked(service.attachmentContent).mockResolvedValueOnce(file);
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true });
  expect(await call("agent.attachmentSave", event(), "session", attachment)).toBe(false);
  expect(service.attachmentContent).toHaveBeenCalledWith("session", attachment);
  vi.mocked(dialog.showSaveDialog).mockClear();
  vi.mocked(service.attachmentContent).mockRejectedValueOnce(new Error("附件完整性校验失败"));
  await expect(call("agent.attachmentSave", event(), "session", attachment)).rejects.toThrow("完整性");
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});
