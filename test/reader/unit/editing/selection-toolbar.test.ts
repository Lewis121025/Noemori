import { describe, expect, it } from "vitest";
import { placeSelectionToolbar } from "@reader/renderer/engine/editing/selection-toolbar";

const viewport = { left: 240, right: 1100, top: 56, bottom: 760 };
const size = { width: 196, height: 42 };

describe("选区工具条的可见位置", () => {
  it("优先放在文字上方并水平居中", () => {
    expect(
      placeSelectionToolbar({ left: 500, right: 600, top: 300, bottom: 330 }, viewport, size),
    ).toEqual({ left: 452, top: 250 });
  });

  it("选区靠近顶栏时放在下方，不覆盖文字", () => {
    const position = placeSelectionToolbar(
      { left: 500, right: 600, top: 65, bottom: 95 },
      viewport,
      size,
    );
    expect(position).toEqual({ left: 452, top: 103 });
  });

  it.each([
    [240, 250, 248],
    [1080, 1100, 896],
  ])("选区 %s–%s 的工具条保持在正文边界内", (left, right, expected) => {
    expect(
      placeSelectionToolbar({ left, right, top: 300, bottom: 330 }, viewport, size)?.left,
    ).toBe(expected);
  });

  it.each([
    [10, 50],
    [770, 800],
  ])("选区滚出视口后隐藏，不留在固定位置", (top, bottom) => {
    expect(
      placeSelectionToolbar({ left: 500, right: 600, top, bottom }, viewport, size),
    ).toBeNull();
  });

  it("窗口窄于工具条时不溢出正文", () => {
    expect(
      placeSelectionToolbar(
        { left: 10, right: 90, top: 200, bottom: 230 },
        { left: 0, right: 180, top: 0, bottom: 700 },
        size,
      ),
    ).toBeNull();
  });
});
