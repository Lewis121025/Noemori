import { describe, expect, it, vi } from "vitest";
import {
  WhiteboardHistory,
  emptyWhiteboard,
  parseWhiteboard,
  serializeWhiteboard,
  type InkPoint,
} from "@reader/shared/whiteboard/model";
import { WhiteboardInput } from "@reader/renderer/whiteboard/input";
import {
  parseShapeFit,
  parseShapeRepairRequest,
  type ShapeRepairRequest,
} from "@reader/shared/whiteboard/recognition";
const p = (x: number, y = 0): InkPoint => ({ x, y, pressure: 0.5 });
const old = { id: "a", width: 2, points: [p(0), p(100, 2)], source: [p(0), p(50, 3), p(100, 2)] };
const initial = { ...emptyWhiteboard(), strokes: [old] };
const replacements = [{ id: "a", points: [p(0), p(100)] }];
const result = { label: "rectangle" as const, points: [p(100), p(100, 100)], replacements };
function draw(board: WhiteboardInput) {
  board.begin(p(100, 2));
  for (let i = 1; i <= 25; i++) board.update(p(100, i * 4));
}
describe("多笔画修复的封闭契约与原子事务", () => {
  it("联动替换和新增只占一次历史，保留原观测与版本2序列化", () => {
    const history = new WhiteboardHistory(initial);
    history.addWithReplacements({ id: "b", width: 2, points: result.points }, replacements);
    expect(history.revision).toBe(1);
    expect(history.document.strokes[0]!.source).toEqual(old.source);
    expect(history.document.strokes[0]!.points).toEqual(replacements[0]!.points);
    expect(parseWhiteboard(serializeWhiteboard(history.document))).toEqual(history.document);
    const after = history.document;
    history.undo();
    expect(history.document).toEqual(initial);
    history.redo();
    expect(history.document).toBe(after);
  });
  it.each([
    [{ id: "missing", points: [p(0), p(10)] }],
    [...replacements, ...replacements],
    [{ id: "a", points: [p(NaN), p(1)] }],
  ])("非法整组变化不污染文档与历史：%o", (changes) => {
    const history = new WhiteboardHistory(initial),
      before = history.document;
    expect(() =>
      history.addWithReplacements({ id: "b", width: 2, points: result.points }, changes),
    ).toThrow();
    expect(history.document).toBe(before);
    expect(history.revision).toBe(0);
    expect(history.canUndo).toBe(false);
  });
  it("请求与返回保留稳定身份，重复身份和未提交身份拒绝", () => {
    const request = {
      points: result.points,
      observations: result.points,
      scale: 1,
      context: [{ id: "a", points: old.points, observations: old.source }],
    };
    expect(parseShapeRepairRequest(request)).toEqual(request);
    expect(parseShapeFit(result, request)).toEqual(result);
    expect(() =>
      parseShapeRepairRequest({ ...request, context: [...request.context, ...request.context] }),
    ).toThrow();
    expect(() =>
      parseShapeFit({ ...result, replacements: [{ ...replacements[0], id: "unknown" }] }, request),
    ).toThrow();
  });
  it("联动预览不修改文档，抬笔整组提交并一次撤销", async () => {
    const repair = vi.fn(async (_request: ShapeRepairRequest) => result),
      board = new WhiteboardInput(initial, vi.fn(), repair);
    draw(board);
    const before = board.document;
    expect(await board.hold()).toBe(true);
    expect(repair.mock.calls[0]![0].context?.map((s) => s.id)).toEqual(["a"]);
    expect(board.document).toBe(before);
    expect(board.displayStrokes[0]!.points).toEqual(replacements[0]!.points);
    board.finish();
    expect(board.document.strokes).toHaveLength(2);
    expect(board.revision).toBe(1);
    board.applyHistory("undo");
    expect(board.document).toEqual(initial);
    board.applyHistory("redo");
    expect(board.document.strokes[0]!.points).toEqual(replacements[0]!.points);
  });
  it.each(["cancel", "move", "late"])(
    "%s恢复全部上下文预览，迟到回复不修改既有笔迹",
    async (action) => {
      let resolve!: (value: typeof result) => void;
      const promise = new Promise<typeof result>((yes) => {
        resolve = yes;
      });
      const board = new WhiteboardInput(initial, vi.fn(), () => promise);
      draw(board);
      const pending = board.hold();
      if (action === "late") board.cancel();
      resolve(result);
      await pending;
      if (action === "move") board.update(p(120, 120));
      else board.cancel();
      expect(board.document).toEqual(initial);
      expect(board.displayStrokes).toEqual(board.document.strokes);
    },
  );
});
