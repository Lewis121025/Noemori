import { describe, expect, it } from "vitest";
import { WhiteboardInput } from "@reader/renderer/whiteboard/input";
import { inkBounds } from "@reader/shared/whiteboard/geometry";
import {
  BOARD_COORDINATE_LIMIT,
  emptyWhiteboard,
  type InkPoint,
} from "@reader/shared/whiteboard/model";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const initial = {
  ...emptyWhiteboard(),
  strokes: [{ id: "a", width: 2, points: [p(40, 20), p(40, 80)] }],
};
const loop = [
  p(0, 0),
  p(50, 0),
  p(100, 0),
  p(100, 50),
  p(100, 100),
  p(50, 100),
  p(0, 100),
  p(0, 50),
  p(0, 0),
];

describe("无工具栏手势状态机", () => {
  it.each([1, 2])("原始采样在 %s 倍缩放下显示、提交与撤销重做时保持坐标和压力", (scale) => {
    const changes: boolean[] = [];
    const board = new WhiteboardInput(emptyWhiteboard(), (changed) => changes.push(changed));
    board.zoom(0, 0, scale);
    const samples = [
      { x: 10, y: 20, pressure: 0.2 },
      { x: 20, y: 30, pressure: 0.4 },
      { x: 30, y: 15, pressure: 0.8 },
      { x: 40, y: 35, pressure: 0.6 },
    ];
    const expected = samples.map((point) => ({
      ...point,
      x: point.x / scale,
      y: point.y / scale,
    }));
    board.begin(samples[0]!);
    for (const sample of samples.slice(1)) board.update(sample);
    expect(board.points).toEqual(expected);
    expect(board.document.strokes).toEqual([]);
    expect(changes.filter(Boolean)).toHaveLength(0);
    board.finish();
    expect(board.document.strokes[0]?.points).toEqual(expected);
    expect(changes.filter(Boolean)).toHaveLength(1);
    board.applyHistory("undo");
    expect(board.document.strokes).toEqual([]);
    board.applyHistory("redo");
    expect(board.document.strokes[0]?.points).toEqual(expected);
  });

  it("停笔保持原始轮廓，未圈选内容时不改成几何模板", () => {
    const board = new WhiteboardInput(emptyWhiteboard(), () => {});
    const samples = Array.from({ length: 13 }, (_, i) => p(10 + i * 8, 30 + Math.sin(i) * 0.8));
    board.begin(samples[0]!);
    for (const sample of samples.slice(1)) board.update(sample);
    expect(board.hold()).toBe(false);
    expect(board.points).toEqual(samples);
    board.finish();
    expect(board.document.strokes[0]?.points).toEqual(samples);
  });

  it.each([
    { x: NaN, y: 0, pressure: 0.5 },
    { x: 0, y: Infinity, pressure: 0.5 },
    { x: 0, y: 0, pressure: 1.1 },
    { x: BOARD_COORDINATE_LIMIT + 1, y: 0, pressure: 0.5 },
  ])("非法采样在入口被拒绝，不截断、不产生手势或历史：%o", (sample) => {
    const board = new WhiteboardInput(emptyWhiteboard(), () => {});
    expect(() => board.begin(sample)).toThrow();
    expect(board.active).toBe(false);
    expect(board.document).toEqual(emptyWhiteboard());
    expect(board.canUndo).toBe(false);
  });

  it("非法后续采样不能污染此前有效笔迹", () => {
    const board = new WhiteboardInput(emptyWhiteboard(), () => {});
    board.begin(p(10, 20));
    expect(() => board.update({ x: 30, y: 40, pressure: NaN })).toThrow();
    expect(board.points).toEqual([p(10, 20)]);
    board.finish();
    expect(board.document.strokes[0]?.points).toEqual([p(10, 20)]);
  });

  it("非法视口参数不能污染相机，平移到内容边界外仍能平移回来", () => {
    const board = new WhiteboardInput(emptyWhiteboard(), () => {});
    const original = board.viewport;
    expect(() => board.pan(Infinity, 0)).toThrow();
    expect(() => board.zoom(10, 20, NaN)).toThrow();
    expect(() => board.zoom(10, 20, 0)).toThrow();
    expect(() => board.fit(NaN, 200)).toThrow();
    expect(board.viewport).toEqual(original);
    board.pan(-BOARD_COORDINATE_LIMIT * 2, 0);
    expect(() => board.begin(p(0, 0))).toThrow();
    board.begin(p(0, 0), true);
    board.update(p(100, 0));
    board.finish();
    expect(board.viewport.x).toBe(-BOARD_COORDINATE_LIMIT * 2 + 100);
  });

  it.each([
    [640, 480],
    [40, 50],
  ])("查看全部完整容纳大跨度内容，放大后能缩回适配比例：%s×%s", (width, height) => {
    const document = {
      ...emptyWhiteboard(),
      strokes: [{ id: "wide", width: 2, points: [p(-20000, -10000), p(20000, 10000)] }],
    };
    const board = new WhiteboardInput(document, () => {});
    board.fit(width, height);
    const fitted = board.viewport;
    const bounds = inkBounds(document.strokes)!;
    expect(bounds.x * fitted.scale + fitted.x).toBeGreaterThanOrEqual(0);
    expect((bounds.x + bounds.width) * fitted.scale + fitted.x).toBeLessThanOrEqual(width);
    expect(bounds.y * fitted.scale + fitted.y).toBeGreaterThanOrEqual(0);
    expect((bounds.y + bounds.height) * fitted.scale + fitted.y).toBeLessThanOrEqual(height);
    board.zoom(width / 2, height / 2, 1.5);
    expect(board.viewport.scale).toBeGreaterThan(fitted.scale);
    board.zoom(width / 2, height / 2, 1 / 1.5);
    expect(board.viewport.scale).toBeCloseTo(fitted.scale, 12);
    expect(board.canUndo).toBe(false);
  });
  it("越界移动提交失败后仍保留待处理事务，修正后可提交且只产生一次历史", () => {
    const limit = BOARD_COORDINATE_LIMIT;
    const original = {
      ...emptyWhiteboard(),
      strokes: [{ id: "edge", width: 2, points: [p(limit - 10, 0), p(limit, 0)] }],
    };
    const board = new WhiteboardInput(original, () => {});
    board.selectAll();
    board.begin(p(limit - 5, 0));
    board.update(p(limit, 0));
    expect(() => board.finish()).toThrow();
    expect(board.document).toEqual(original);
    expect(board.active).toBe(true);
    expect(() => board.finish()).toThrow();
    board.update(p(limit - 6, 0));
    board.finish();
    expect(board.active).toBe(false);
    expect(board.revision).toBe(1);
    board.applyHistory("undo");
    expect(board.document).toEqual(original);
  });
  it("普通画圈是笔迹，停笔确认圈选才选择且不产生历史", () => {
    const board = new WhiteboardInput(initial, () => {});
    board.begin(loop[0]!);
    for (const point of loop.slice(1)) board.update(point);
    expect(board.hold()).toBe(true);
    board.finish();
    expect([...board.selection]).toEqual(["a"]);
    expect(board.canUndo).toBe(false);
    board.begin(p(40, 40));
    board.update(p(60, 60));
    expect(board.document).toEqual(initial);
    board.finish();
    expect(board.document.strokes[0]?.points[0]).toEqual(p(60, 40));
    board.applyHistory("undo");
    expect(board.document).toEqual(initial);
    board.begin(loop[0]!);
    for (const point of loop.slice(1)) board.update(point);
    board.finish();
    expect(board.document.strokes).toHaveLength(2);
  });

  it("涂划一次删除并一次撤销恢复，平移缩放不进入文档历史", () => {
    const changes: boolean[] = [];
    const board = new WhiteboardInput(initial, (changed) => changes.push(changed));
    const scratch = [p(10, 25), p(90, 35), p(10, 45), p(90, 55), p(10, 65), p(90, 75)];
    board.begin(scratch[0]!);
    for (const point of scratch.slice(1)) board.update(point);
    board.finish();
    expect(board.document.strokes).toHaveLength(0);
    expect(changes.filter(Boolean)).toHaveLength(1);
    board.applyHistory("undo");
    board.pan(25, 50);
    board.zoom(100, 100, 2);
    board.begin(p(50, 50), true);
    board.update(p(80, 60));
    board.finish();
    expect(board.document).toEqual(initial);
    expect(board.canUndo).toBe(false);
  });

  it("取消笔迹不写入，离开前结束未完成笔迹会保留采样", () => {
    const board = new WhiteboardInput(emptyWhiteboard(), () => {});
    board.begin(p(10, 10));
    board.update(p(20, 20));
    board.cancel();
    expect(board.document.strokes).toHaveLength(0);
    board.begin(p(10, 10));
    board.update(p(20, 20));
    board.finish();
    expect(board.document.strokes[0]?.points).toEqual([p(10, 10), p(20, 20)]);
  });
});
