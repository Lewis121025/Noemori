import { describe, expect, it } from "vitest";
import { selectFileRows } from "@reader/renderer/engine/navigation/file-selection";

describe("文件多选", () => {
  const rows = ["a", "b", "c", "d"];
  it("范围选择可反向收缩，锚点不跟随每次方向键移动", () => {
    const initial = { paths: new Set(["b"]), anchor: "b" };
    const extended = selectFileRows(initial, rows, "d", "range");
    expect([...extended.paths]).toEqual(["b", "c", "d"]);
    expect([...selectFileRows(extended, rows, "c", "range").paths]).toEqual(["b", "c"]);
    expect([...selectFileRows(extended, rows, "a", "range").paths]).toEqual(["a", "b"]);
  });
  it("切换选择不打开文件，隐藏的锚点退回当前目标而非选中全部前序项", () => {
    const initial = { paths: new Set(["a", "hidden"]), anchor: "hidden" };
    expect([...selectFileRows(initial, rows, "c", "toggle").paths]).toEqual(["a", "c"]);
    expect([...selectFileRows(initial, rows, "a", "toggle").paths]).toEqual([]);
    expect([...selectFileRows(initial, rows, "c", "range").paths]).toEqual(["c"]);
    expect([...selectFileRows(initial, rows, "c", "extend").paths]).toEqual(["a", "c"]);
  });
});
