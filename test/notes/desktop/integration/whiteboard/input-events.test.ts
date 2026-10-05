/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WhiteboardEditor from "@reader/renderer/whiteboard/WhiteboardEditor.svelte";
import type { WhiteboardEditorApi } from "@reader/renderer/editor/editor-api";
import { emptyWhiteboard, parseWhiteboard } from "@reader/shared/whiteboard/model";
import type { InkPoint } from "@reader/shared/whiteboard/model";
import type { ShapePrediction } from "@reader/shared/whiteboard/recognition";

let component: ReturnType<typeof mount> | undefined;
const registered: { api: WhiteboardEditorApi | null } = { api: null };

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  registered.api = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(
  recognize?: (points: readonly InkPoint[]) => Promise<ShapePrediction>,
  readOnly = false,
) {
  component = mount(WhiteboardEditor, {
    target: document.body,
    props: {
      board: emptyWhiteboard(),
      epoch: 0,
      readOnly,
      onDirty: () => {},
      register: (api: WhiteboardEditorApi | null) => {
        registered.api = api;
      },
      ...(recognize ? { recognize } : {}),
    },
  });
  flushSync();
  await Promise.resolve();
  flushSync();
  const host = document.querySelector<HTMLElement>(".whiteboard");
  if (!host) throw new Error("白板未挂载");
  Object.assign(host, {
    setPointerCapture: () => {},
    hasPointerCapture: () => false,
    releasePointerCapture: () => {},
  });
  return host;
}

function pointer(host: HTMLElement, type: string, x: number, y: number, pressure = 0.5) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "pen" },
    pressure: { value: pressure },
  });
  host.dispatchEvent(event);
  flushSync();
}

function saved() {
  if (!registered.api) throw new Error("白板未注册");
  return parseWhiteboard(new TextDecoder().decode(registered.api.snapshot().bytes));
}

it("非法笔压不会被界面截断后写入，也不会占用下一次落笔", async () => {
  const host = await start();
  const capture = vi.fn();
  Object.assign(host, { setPointerCapture: capture });
  pointer(host, "pointerdown", 10, 20, 2);
  expect(saved().strokes).toEqual([]);
  expect(capture).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("无效");
  pointer(host, "pointerdown", 10, 20, 0.5);
  pointer(host, "pointerup", 20, 30, 0);
  expect(saved().strokes).toHaveLength(1);
});

it.each([
  [55, 70],
  [30.1, 40.1],
])("抬笔包含最后位移时保留终点 %s,%s，即使没有对应 pointermove", async (x, y) => {
  const host = await start();
  pointer(host, "pointerdown", 10, 20, 0.2);
  pointer(host, "pointermove", 30, 40, 0.8);
  pointer(host, "pointerup", x, y, 0);
  expect(saved().strokes[0]?.points.at(-1)).toEqual({ x, y, pressure: 0 });
});

it("失去捕获时只提交已有真实采样，不把空事件坐标补进笔迹", async () => {
  const host = await start();
  pointer(host, "pointerdown", 10, 20);
  pointer(host, "pointermove", 30, 40);
  pointer(host, "lostpointercapture", 0, 0, 0);
  expect(saved().strokes[0]?.points.at(-1)).toEqual({ x: 30, y: 40, pressure: 0.5 });
});

it("自由笔迹停笔时保持轮廓，抬笔后保存相同的真实采样", async () => {
  vi.useFakeTimers();
  const host = await start();
  const samples = Array.from({ length: 13 }, (_, i) => ({
    x: 10 + i * 8,
    y: 30 + Math.sin(i) * 0.8,
    pressure: 0.5,
  }));
  pointer(host, "pointerdown", samples[0]!.x, samples[0]!.y);
  for (const point of samples.slice(1)) pointer(host, "pointermove", point.x, point.y);
  const pending = host.querySelector(".pending")?.getAttribute("d");
  expect(pending).toBeTruthy();
  await vi.advanceTimersByTimeAsync(500);
  flushSync();
  expect(host.querySelector(".pending")?.getAttribute("d")).toBe(pending);
  expect(saved().strokes).toHaveLength(0);
  pointer(host, "pointerup", samples.at(-1)!.x, samples.at(-1)!.y);
  expect(saved().strokes[0]?.points).toEqual(samples);
  expect(host.querySelector("[data-stroke-id]")?.getAttribute("d")).toBe(pending);
});

it("合并事件作为唯一真实采样，父事件的不同坐标不会额外写入", async () => {
  const host = await start();
  pointer(host, "pointerdown", 0, 0);
  const move = new MouseEvent("pointermove", { bubbles: true, clientX: 999, clientY: 999 });
  Object.defineProperties(move, {
    pointerId: { value: 1 },
    getCoalescedEvents: {
      value: () =>
        [10, 20, 30].map((x) => ({
          clientX: x,
          clientY: 0,
          pressure: 0.5,
          pointerType: "pen",
          timeStamp: x,
        })),
    },
  });
  host.dispatchEvent(move);
  flushSync();
  registered.api!.finishInput();
  const points = saved().strokes[0]!.points;
  expect(points).toEqual([0, 10, 20, 30].map((x) => ({ x, y: 0, pressure: 0.5 })));
});

it("阅读模式只平移白板，不落笔也不显示编辑工具", async () => {
  vi.useFakeTimers();
  const recognize = vi.fn(async (): Promise<ShapePrediction> => ({
    label: "line",
    confidence: 0.99,
  }));
  const host = await start(recognize, true);
  expect(host.querySelector('[aria-label="白板编辑工具栏"]')).toBeNull();
  pointer(host, "pointerdown", 10, 20);
  pointer(host, "pointermove", 70, 90);
  await vi.advanceTimersByTimeAsync(500);
  expect(recognize).not.toHaveBeenCalled();
  pointer(host, "pointerup", 100, 120);
  expect(saved().strokes).toEqual([]);
  expect(host.querySelector("g")?.getAttribute("transform")).not.toContain("translate(0 0)");
  expect(registered.api?.historyAvailability()).toEqual({ undo: false, redo: false });
});

it("一笔直线停顿 450ms 后预览修复，抬笔保存修正且撤销恢复空白", async () => {
  vi.useFakeTimers();
  const recognize = vi.fn(async (): Promise<ShapePrediction> => ({
    label: "line",
    confidence: 0.99,
  }));
  const host = await start(recognize);
  pointer(host, "pointerdown", 10, 30);
  for (let i = 1; i <= 20; i++) pointer(host, "pointermove", 10 + i * 5, 30 + Math.sin(i) * 0.6);
  const original = host.querySelector(".pending")!.getAttribute("d");
  await vi.advanceTimersByTimeAsync(449);
  expect(recognize).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  flushSync();
  expect(recognize).toHaveBeenCalledTimes(1);
  const preview = host.querySelector(".pending.corrected")!.getAttribute("d");
  expect(preview).not.toBe(original);
  expect(saved().strokes).toHaveLength(0);
  pointer(host, "pointerup", 110, 30 + Math.sin(20) * 0.6, 0);
  expect(saved().strokes[0]!.points).toHaveLength(2);
  expect(host.querySelector("[data-stroke-id]")!.getAttribute("d")).toBe(preview);
  registered.api!.history("undo");
  expect(saved().strokes).toHaveLength(0);
});

it("停笔后抬笔不会等待推理，迟到结果与卸载后的错误都不污染文档", async () => {
  vi.useFakeTimers();
  let resolve!: (value: ShapePrediction) => void;
  const task = new Promise<ShapePrediction>((yes) => {
    resolve = yes;
  });
  const host = await start(() => task);
  pointer(host, "pointerdown", 10, 20);
  pointer(host, "pointermove", 100, 20);
  await vi.advanceTimersByTimeAsync(450);
  pointer(host, "pointerup", 110, 25);
  const original = saved();
  resolve({ label: "line", confidence: 0.99 });
  await Promise.resolve();
  flushSync();
  expect(saved()).toEqual(original);
  expect(host.querySelector(".corrected")).toBeNull();
});

it.each([
  [2.5, -0.9],
  [-2.5, 0.9],
])("停笔范围内从 %s 抖到 %s 不会丢弃推理结果后停止重试", async (before, after) => {
  vi.useFakeTimers();
  let resolve!: (value: ShapePrediction) => void;
  const task = new Promise<ShapePrediction>((yes) => {
    resolve = yes;
  });
  const recognize = vi.fn(() => task);
  const host = await start(recognize);
  pointer(host, "pointerdown", 10, 30);
  for (let i = 1; i <= 20; i++) pointer(host, "pointermove", 10 + i * 5, 30);
  pointer(host, "pointermove", 110 + before, 30);
  await vi.advanceTimersByTimeAsync(450);
  expect(recognize).toHaveBeenCalledTimes(1);
  // 两个采样都在同一个停笔区域内，相对最后采样的距离却超过 3px。
  pointer(host, "pointermove", 110 + after, 30);
  resolve({ label: "line", confidence: 0.99 });
  await Promise.resolve();
  flushSync();
  expect(host.querySelector(".pending.corrected")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(recognize).toHaveBeenCalledTimes(1);
  pointer(host, "pointerup", 110 + after, 30, 0);
  expect(saved().strokes[0]!.points).toHaveLength(2);
});

it("离开静止区域后丢弃旧推理，即使相对最后采样不到 3px，也会重新计时", async () => {
  vi.useFakeTimers();
  let first!: (value: ShapePrediction) => void;
  let second!: (value: ShapePrediction) => void;
  const initial = new Promise<ShapePrediction>((yes) => {
    first = yes;
  });
  const next = new Promise<ShapePrediction>((yes) => {
    second = yes;
  });
  const recognize = vi
    .fn<(points: readonly InkPoint[]) => Promise<ShapePrediction>>()
    .mockReturnValueOnce(initial)
    .mockReturnValueOnce(next);
  const host = await start(recognize);
  pointer(host, "pointerdown", 10, 30);
  for (let i = 1; i <= 20; i++) pointer(host, "pointermove", 10 + i * 5, 30);
  pointer(host, "pointermove", 112.5, 30);
  await vi.advanceTimersByTimeAsync(450);
  expect(recognize).toHaveBeenCalledTimes(1);
  pointer(host, "pointermove", 114, 30);
  first({ label: "line", confidence: 0.99 });
  await Promise.resolve();
  flushSync();
  expect(host.querySelector(".pending.corrected")).toBeNull();
  await vi.advanceTimersByTimeAsync(449);
  expect(recognize).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(recognize).toHaveBeenCalledTimes(2);
  second({ label: "line", confidence: 0.99 });
  await Promise.resolve();
  flushSync();
  expect(host.querySelector(".pending.corrected")).not.toBeNull();
});

it("推理失败提示不会被微抖或抬笔清空，下一次落笔才清除旧错误", async () => {
  vi.useFakeTimers();
  const host = await start(async () => {
    throw new Error("权重未加载");
  });
  pointer(host, "pointerdown", 10, 30);
  pointer(host, "pointermove", 110, 30);
  await vi.advanceTimersByTimeAsync(450);
  flushSync();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("权重未加载");
  pointer(host, "pointermove", 110.1, 30);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("权重未加载");
  pointer(host, "pointerup", 110.1, 30, 0);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("权重未加载");
  expect(saved().strokes).toHaveLength(1);
  pointer(host, "pointerdown", 200, 30);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("移动会重置停笔计时；平移和取消不触发分类", async () => {
  vi.useFakeTimers();
  const recognize = vi.fn(async (): Promise<ShapePrediction> => ({
    label: "line",
    confidence: 0.99,
  }));
  const host = await start(recognize);
  pointer(host, "pointerdown", 10, 20);
  pointer(host, "pointermove", 50, 20);
  await vi.advanceTimersByTimeAsync(400);
  pointer(host, "pointermove", 100, 20);
  await vi.advanceTimersByTimeAsync(400);
  expect(recognize).not.toHaveBeenCalled();
  pointer(host, "pointercancel", 100, 20);
  await vi.advanceTimersByTimeAsync(500);
  expect(recognize).not.toHaveBeenCalled();
  host.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
  pointer(host, "pointerdown", 10, 20);
  pointer(host, "pointermove", 100, 20);
  await vi.advanceTimersByTimeAsync(500);
  expect(recognize).not.toHaveBeenCalled();
});

it("持续停笔微抖不应因静止区域中心偏在边缘而永远重置计时", async () => {
  vi.useFakeTimers();
  const recognize = vi.fn<(points: readonly InkPoint[]) => Promise<ShapePrediction>>(async () => ({
    label: "line",
    confidence: 0.99,
  }));
  const host = await start(recognize);
  pointer(host, "pointerdown", 10, 30);
  for (let i = 1; i <= 96; i++) pointer(host, "pointermove", 10 + (40 * i) / 96, 30);
  for (let i = 1; i <= 120; i++) {
    pointer(
      host,
      "pointermove",
      50 + (2.5 * Math.sin(i * 0.37)) / Math.SQRT2,
      30 + (2.5 * Math.sin(i * 0.53)) / Math.SQRT2,
    );
    await vi.advanceTimersByTimeAsync(8);
  }
  flushSync();
  expect(recognize).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".pending.corrected")).not.toBeNull();
  const observed = recognize.mock.calls[0]![0];
  expect(observed.length).toBeLessThan(105);
  expect(Math.hypot(observed.at(-1)!.x - 50, observed.at(-1)!.y - 30)).toBeLessThan(0.8);
});

it("连续缓慢绘制超过停笔时间仍不推理，真正停下后才触发", async () => {
  vi.useFakeTimers();
  const recognize = vi.fn(async (): Promise<ShapePrediction> => ({
    label: "line",
    confidence: 0.99,
  }));
  const host = await start(recognize);
  pointer(host, "pointerdown", 10, 30);
  for (let i = 1; i <= 240; i++) {
    pointer(host, "pointermove", 10 + 0.4 * i, 30);
    await vi.advanceTimersByTimeAsync(8);
    expect(recognize).not.toHaveBeenCalled();
  }
  await vi.advanceTimersByTimeAsync(450);
  flushSync();
  expect(recognize).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".pending.corrected")).not.toBeNull();
});

it.each(["circle", "ellipse", "rectangle"] as const)(
  "%s 在持续二维停笔抖动中只修复一次，预览保持稳定",
  async (label) => {
    vi.useFakeTimers();
    const recognize = vi.fn(async (): Promise<ShapePrediction> => ({ label, confidence: 0.99 }));
    const host = await start(recognize);
    const points =
      label === "rectangle"
        ? [
            [30, 30],
            [70, 30],
            [70, 60],
            [30, 60],
            [30, 30],
          ]
            .slice(1)
            .flatMap((end, i) => {
              const start = [
                [30, 30],
                [70, 30],
                [70, 60],
                [30, 60],
              ][i]!;
              return Array.from({ length: 64 }, (_, j) => ({
                x: start[0]! + ((end[0]! - start[0]!) * j) / 64,
                y: start[1]! + ((end[1]! - start[1]!) * j) / 64,
              }));
            })
            .concat({ x: 30, y: 30 })
        : Array.from({ length: 257 }, (_, i) => ({
            x: 50 + 20 * Math.cos((i * Math.PI) / 128),
            y: 50 + (label === "ellipse" ? 12 : 20) * Math.sin((i * Math.PI) / 128),
          }));
    pointer(host, "pointerdown", points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) pointer(host, "pointermove", point.x, point.y);
    const last = points.at(-1)!;
    for (let i = 1; i <= 180; i++) {
      pointer(
        host,
        "pointermove",
        last.x + (2.5 * Math.sin(i * 0.37)) / Math.SQRT2,
        last.y + (2.5 * Math.sin(i * 0.53)) / Math.SQRT2,
      );
      await vi.advanceTimersByTimeAsync(8);
    }
    flushSync();
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".pending.corrected")).not.toBeNull();
  },
);
