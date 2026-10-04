import { beforeEach, expect, it, vi } from "vitest";
import { registerWhiteboardIpc } from "@reader/main/whiteboard-ipc";
import type { BrowserWindow } from "electron";

const port = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: { sender: object; senderFrame: object }, value: unknown) => Promise<unknown>
  >(),
  classify: vi.fn(),
  create: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { sender: object; senderFrame: object }, value: unknown) => Promise<unknown>,
    ) => port.handlers.set(channel, handler),
  },
}));
vi.mock("../../../../../modules/notes/packages/vault-node/index.js", () => ({
  NativeInk: class {
    constructor(path: string) {
      port.create(path);
    }
    classify(coordinates: number[]) {
      return port.classify(coordinates);
    }
  },
}));

const frame = {};
const contents = { mainFrame: frame, isDestroyed: () => false };
const points = [
  { x: 10, y: 20, pressure: 0.5 },
  { x: 100, y: 20, pressure: 0.5 },
];
beforeEach(() => {
  port.handlers.clear();
  port.create.mockClear();
  port.classify.mockReset();
  port.classify.mockResolvedValue({ label: "line", confidence: 0.99 });
  // Electron 窗口的其余能力不会被这个受限识别入口访问。
  registerWhiteboardIpc(() => ({ webContents: contents }) as unknown as BrowserWindow);
});
const invoke = (value: unknown, sender = contents, senderFrame: object = frame) =>
  port.handlers.get("reader.whiteboard.recognize")!({ sender, senderFrame }, value);

it("校验采样后在固定权重上分类，复用会话且严格校验返回协议", async () => {
  expect(await invoke(points)).toEqual({ label: "line", confidence: 0.99 });
  expect(port.classify).toHaveBeenCalledWith([10, 20, 100, 20]);
  await invoke(points);
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(port.create.mock.calls[0]![0]).toMatch(/ink[\\/]model\.onnx$/);
  port.classify.mockResolvedValue({ label: "square", confidence: 1 });
  await expect(invoke(points)).rejects.toThrow("类别无效");
});

it("其他窗口、子框架和非法采样不能加载模型或进入后台推理", async () => {
  await expect(invoke(points, { ...contents })).rejects.toThrow("来源无效");
  await expect(invoke(points, contents, {})).rejects.toThrow("来源无效");
  await expect(invoke([{ ...points[0]!, x: NaN }, points[1]])).rejects.toThrow("采样无效");
  expect(port.create).not.toHaveBeenCalled();
  expect(port.classify).not.toHaveBeenCalled();
});
