import { repairScene } from "@reader/shared/whiteboard/fitting-scene";
import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { registerWhiteboardIpc } from "@reader/main/whiteboard-ipc";
import { parseShapeFit } from "@reader/shared/whiteboard/recognition";

const port = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value: unknown) => unknown) =>
      port.handlers.set(name, handler),
  },
}));
const frame = {},
  contents = { isDestroyed: () => false, mainFrame: frame };
const points = [
  { x: 10, y: 20, pressure: 0.5 },
  { x: 100, y: 20, pressure: 0.5 },
];
const request = { points, observations: points, scale: 1 };
beforeEach(() => {
  port.handlers.clear();
  registerWhiteboardIpc(
    () => ({ webContents: contents }) as unknown as BrowserWindow,
    async (request) => repairScene(request),
  );
});
const invoke = async (value: unknown, sender = contents, senderFrame: object = frame) =>
  port.handlers.get("reader.whiteboard.repair")!({ sender, senderFrame }, value);

it("后台直接返回规范轮廓，缩放和完整观测共同约束，不加载分类模型", async () => {
  const result = parseShapeFit(await invoke(request));
  expect(result).toMatchObject({ label: "line" });
  const fitted = result!.points;
  expect(fitted).toHaveLength(2);
  expect(fitted[0]!.x).toBeCloseTo(10, 10);
  expect(fitted[1]!.x).toBeCloseTo(100, 10);
  expect(await invoke({ ...request, scale: 0.1 })).toBeNull();
  expect(
    await invoke({ ...request, observations: [...points, { x: 50, y: 80, pressure: 0.5 }] }),
  ).toBeNull();
  expect(port.handlers.has("reader.whiteboard.recognize")).toBe(false);
});
it("其他窗口、子框架及非法采样不能进入几何计算", async () => {
  await expect(invoke(request, { ...contents })).rejects.toThrow("来源无效");
  await expect(invoke(request, contents, {})).rejects.toThrow("来源无效");
  await expect(
    invoke({ ...request, points: [{ ...points[0]!, x: NaN }, points[1]] }),
  ).rejects.toThrow("采样无效");
  await expect(invoke({ ...request, scale: NaN })).rejects.toThrow("请求无效");
});
