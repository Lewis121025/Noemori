/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WhiteboardEditor from "@reader/renderer/whiteboard/WhiteboardEditor.svelte";
import type { WhiteboardEditorApi } from "@reader/renderer/editor/editor-api";
import { emptyWhiteboard, parseWhiteboard } from "@reader/shared/whiteboard/model";

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

async function start() {
  component = mount(WhiteboardEditor, {
    target: document.body,
    props: {
      board: emptyWhiteboard(),
      epoch: 0,
      onDirty: () => {},
      register: (api: WhiteboardEditorApi | null) => {
        registered.api = api;
      },
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
