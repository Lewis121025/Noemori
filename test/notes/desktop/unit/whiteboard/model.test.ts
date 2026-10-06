import { describe, expect, it } from "vitest";
import {
  WhiteboardHistory,
  emptyWhiteboard,
  parseWhiteboard,
  serializeWhiteboard,
} from "@reader/shared/whiteboard/model";
import type { InkStroke } from "@reader/shared/whiteboard/model";

const stroke: InkStroke = {
  id: "a",
  width: 2,
  points: [
    { x: 10.25, y: -3, pressure: 0.3 },
    { x: 50, y: 20, pressure: 0.8 },
  ],
};

describe("白板文件与事务", () => {
  it("平滑轨迹与原始观测可独立无损保存，旧版读取保留几何，移动与撤销同步两份坐标", () => {
    const source = [...stroke.points, { x: 52, y: 24, pressure: 0.5 }];
    const board = parseWhiteboard(JSON.stringify({ version: 2, strokes: [{ ...stroke, source }] }));
    expect(board.version).toBe(2);
    expect(board.strokes[0]!.source).toEqual(source);
    expect(parseWhiteboard(serializeWhiteboard(board))).toEqual(board);
    const old = parseWhiteboard(JSON.stringify({ version: 1, strokes: [stroke] }));
    expect(old.strokes).toEqual([stroke]);
    expect(old.version).toBe(2);
    const history = new WhiteboardHistory(board);
    history.move(new Set(["a"]), 4, 7);
    expect(history.document.strokes[0]!.points[0]).toEqual({ ...stroke.points[0], x: 14.25, y: 4 });
    expect(history.document.strokes[0]!.source?.at(-1)).toEqual({ x: 56, y: 31, pressure: 0.5 });
    history.undo();
    expect(history.document).toEqual(board);
    expect(() =>
      parseWhiteboard(JSON.stringify({ version: 1, strokes: [{ ...stroke, source }] })),
    ).toThrow();
    expect(() =>
      parseWhiteboard(
        JSON.stringify({
          version: 2,
          strokes: [{ ...stroke, source: [{ x: NaN, y: 0, pressure: 0.5 }] }],
        }),
      ),
    ).toThrow();
  });
  it("保留原始坐标和压力，拒绝无效版本、重复身份及非有限坐标", () => {
    const board = { ...emptyWhiteboard(), strokes: [stroke] };
    expect(parseWhiteboard(serializeWhiteboard(board))).toEqual(board);
    expect(() => parseWhiteboard('{"version":3,"strokes":[]}')).toThrow();
    expect(() =>
      parseWhiteboard(JSON.stringify({ ...board, strokes: [stroke, stroke] })),
    ).toThrow();
    expect(() =>
      parseWhiteboard(
        '{"version":1,"strokes":[{"id":"a","width":2,"points":[{"x":1e999,"y":0,"pressure":0.5}]}]}',
      ),
    ).toThrow();
    expect(() => parseWhiteboard('{"version":1,"strokes":[],"unknown":true}')).toThrow();
  });

  it("删除和整组移动各为一次事务，撤销恢复精确原始笔迹", () => {
    const history = new WhiteboardHistory(emptyWhiteboard());
    history.add(stroke);
    const original = serializeWhiteboard(history.document);
    history.move(new Set(["a"]), 4.125, 12);
    expect(history.document.strokes[0]?.points[0]).toEqual({ x: 14.375, y: 9, pressure: 0.3 });
    history.remove(new Set(["a"]));
    expect(history.document.strokes).toEqual([]);
    history.undo();
    history.undo();
    expect(serializeWhiteboard(history.document)).toBe(original);
    history.redo();
    expect(history.canRedo).toBe(true);
    history.add({ ...stroke, id: "b" });
    expect(history.canRedo).toBe(false);
  });

  it("无实际改动不污染历史，越界移动和重复笔迹不能部分提交", () => {
    const history = new WhiteboardHistory({ ...emptyWhiteboard(), strokes: [stroke] });
    expect(history.move(new Set(["a"]), 0, 0)).toBe(false);
    expect(history.remove(new Set(["missing"]))).toBe(false);
    expect(history.canUndo).toBe(false);
    expect(() => history.move(new Set(["a"]), Infinity, 0)).toThrow();
    expect(() => history.add(stroke)).toThrow();
    expect(history.document.strokes).toEqual([stroke]);
  });
});
