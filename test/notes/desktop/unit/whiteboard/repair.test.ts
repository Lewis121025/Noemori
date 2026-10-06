import { expect, it, vi } from "vitest";
import { WhiteboardInput } from "@reader/renderer/whiteboard/input";
import { emptyWhiteboard, type InkPoint } from "@reader/shared/whiteboard/model";
import type { ShapePrediction } from "@reader/shared/whiteboard/recognition";

const p = (x: number, y = 0): InkPoint => ({ x, y, pressure: 0.5 });
const samples = Array.from({ length: 25 }, (_, i) => p(i * 4, Math.sin(i) * 0.6));
function draw(board: WhiteboardInput) {
  board.begin(samples[0]!);
  for (const point of samples.slice(1)) board.update(point);
}
function deferred() {
  let resolve!: (value: ShapePrediction) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<ShapePrediction>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const prediction = { label: "line", confidence: 0.99 } satisfies ShapePrediction;

it.each([
  { ratio: 0.72, predicted: "circle", expected: "ellipse" },
  { ratio: 1, predicted: "ellipse", expected: "circle" },
] as const)("停笔保存最终几何轮廓，模型标签$predicted与最终类型$expected分离", async (test) => {
  const recognize = vi.fn(async () => ({
    label: test.predicted,
    confidence: 0.8,
    oval: {
      circle: test.predicted === "circle" ? 0.8 : 0.2,
      ellipse: test.predicted === "ellipse" ? 0.8 : 0.2,
    },
    refinement: {
      label: test.expected,
      confidence: 0.8,
      oval: {
        circle: test.expected === "circle" ? 0.8 : 0.2,
        ellipse: test.expected === "ellipse" ? 0.8 : 0.2,
      },
    },
  }));
  const board = new WhiteboardInput(emptyWhiteboard(), vi.fn(), recognize);
  const points = Array.from({ length: 193 }, (_, i) =>
    p(
      500 + 100 * Math.cos((2 * Math.PI * i) / 192),
      300 + 100 * test.ratio * Math.sin((2 * Math.PI * i) / 192),
    ),
  );
  board.begin(points[0]!);
  for (const point of points.slice(1)) board.update(point);
  expect(await board.hold()).toBe(true);
  expect(board.correctedLabel).toBe(test.expected);
  const preview = [...board.points];
  board.finish();
  expect(board.correctedLabel).toBeNull();
  expect(board.document.strokes[0]!.points).toEqual(preview);
  board.applyHistory("undo");
  expect(board.document.strokes).toHaveLength(0);
  board.applyHistory("redo");
  expect(board.document.strokes[0]!.points).toEqual(preview);
});

it("停笔识别直线无需画圈，预览不占历史，抬笔一次提交并一次撤销重做", async () => {
  const changed = vi.fn();
  const recognize = vi.fn(async () => prediction);
  const board = new WhiteboardInput(emptyWhiteboard(), changed, recognize);
  draw(board);
  expect(await board.hold()).toBe(true);
  expect(recognize).toHaveBeenCalledWith(samples);
  expect(board.corrected).toBe(true);
  expect(board.points).toHaveLength(2);
  expect(board.document.strokes).toHaveLength(0);
  expect(board.revision).toBe(0);
  const preview = [...board.points];
  board.finish({ ...samples.at(-1)!, pressure: 0 });
  expect(board.document.strokes[0]!.points).toEqual(preview);
  expect(changed.mock.calls.filter(([edited]) => edited)).toHaveLength(1);
  board.applyHistory("undo");
  expect(board.document.strokes).toHaveLength(0);
  board.applyHistory("redo");
  expect(board.document.strokes[0]!.points).toEqual(preview);
});

it.each(["finish", "cancel", "dispose", "move", "replace"])(
  "%s 后的迟到结果不覆盖当前输入或文档",
  async (action) => {
    const pending = deferred();
    const board = new WhiteboardInput(
      emptyWhiteboard(),
      () => {},
      () => pending.promise,
    );
    draw(board);
    const held = board.hold();
    if (action === "move") board.update(p(140, 30));
    else if (action === "replace") {
      board.finish();
      board.begin(p(300, 300));
    } else if (action === "finish") board.finish();
    else if (action === "cancel") board.cancel();
    else board.dispose();
    const document = board.document,
      points = [...board.points];
    pending.resolve(prediction);
    expect(await held).toBe(false);
    expect(board.corrected).toBe(false);
    expect(board.document).toBe(document);
    expect(board.points).toEqual(points);
  },
);

it("继续绘制恢复完整原始采样，新的停笔可重新识别；微小笔尖抖动不取消预览", async () => {
  const board = new WhiteboardInput(
    emptyWhiteboard(),
    () => {},
    async () => prediction,
  );
  draw(board);
  await board.hold();
  board.update(p(97, 0));
  expect(board.corrected).toBe(true);
  board.update(p(104, 0));
  expect(board.corrected).toBe(false);
  expect(board.points.slice(0, samples.length)).toEqual(samples);
  expect(await board.hold()).toBe(true);
});

it("分类低置信度、不匹配与推理失败都保留原笔迹；有效错误传播，过期错误丢弃", async () => {
  for (const predicted of [
    { ...prediction, confidence: 0.49 },
    { label: "circle", confidence: 0.99 } satisfies ShapePrediction,
  ]) {
    const board = new WhiteboardInput(
      emptyWhiteboard(),
      () => {},
      async () => predicted,
    );
    draw(board);
    expect(await board.hold()).toBe(false);
    expect(board.points).toEqual(samples);
  }
  const failed = new WhiteboardInput(
    emptyWhiteboard(),
    () => {},
    async () => {
      throw new Error("推理失败");
    },
  );
  draw(failed);
  await expect(failed.hold()).rejects.toThrow("推理失败");
  expect(failed.points).toEqual(samples);
  const pending = deferred();
  const board = new WhiteboardInput(
    emptyWhiteboard(),
    () => {},
    () => pending.promise,
  );
  draw(board);
  const held = board.hold();
  board.cancel();
  pending.reject(new Error("旧请求失败"));
  expect(await held).toBe(false);
});

it("重复停笔不会重复推理；单点和平移不会触发", async () => {
  const pending = deferred(),
    recognize = vi.fn(() => pending.promise);
  const board = new WhiteboardInput(emptyWhiteboard(), () => {}, recognize);
  board.begin(p(0));
  expect(await board.hold()).toBe(false);
  board.cancel();
  board.begin(p(0), true);
  board.update(p(100));
  expect(await board.hold()).toBe(false);
  board.cancel();
  draw(board);
  const held = board.hold();
  expect(await board.hold()).toBe(false);
  expect(recognize).toHaveBeenCalledTimes(1);
  pending.resolve(prediction);
  await held;
});

it("静止观测仅归并识别快照，修复失败与继续绘制均保留完整原始笔迹", async () => {
  const recognize = vi.fn<(points: readonly InkPoint[]) => Promise<ShapePrediction>>(async () => ({
    label: "other",
    confidence: 0.99,
  }));
  const board = new WhiteboardInput(emptyWhiteboard(), () => {}, recognize);
  draw(board);
  for (let i = 1; i <= 80; i++)
    board.update(p(96 + 1.7 * Math.sin(i * 1.3), samples.at(-1)!.y + 1.7 * Math.sin(i * 1.7)));
  const raw = [...board.points];
  expect(await board.hold()).toBe(false);
  expect(recognize.mock.calls[0]![0].length).toBeLessThan(raw.length);
  expect(board.points).toEqual(raw);
  board.update(p(140, 20));
  expect(board.points.slice(0, raw.length)).toEqual(raw);
  board.finish();
  expect(board.document.strokes[0]!.points.slice(0, raw.length)).toEqual(raw);
});

it("取消预览的移动即使低于采样间距，也必须立即通知画面恢复原笔迹", async () => {
  const changed = vi.fn();
  const board = new WhiteboardInput(emptyWhiteboard(), changed, async () => prediction);
  draw(board);
  await board.hold();
  const last = samples.at(-1)!;
  board.update(p(last.x + 2.9, last.y));
  expect(board.corrected).toBe(true);
  changed.mockClear();
  board.update(p(last.x + 3.1, last.y));
  expect(board.corrected).toBe(false);
  expect(changed).toHaveBeenCalledExactlyOnceWith(false);
});
