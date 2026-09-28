import { describe, expect, it } from "vitest";
import { fileTreeWindow } from "@reader/renderer/engine/navigation/file-tree-window";

describe("目录可视范围", () => {
  it("空目录没有行，小目录完整显示", () => {
    expect(fileTreeWindow(0, 0, 500, 35.2, [])).toEqual([]);
    expect(fileTreeWindow(3, 0, 0, 35.2, [])).toEqual([0, 1, 2]);
  });
  it("只选择视口及缓冲行，完整包含部分可见的上下边缘", () => {
    const indices = fileTreeWindow(10_000, 3520.5, 500, 35.2, []);
    expect(indices).toContain(100);
    expect(indices).toContain(114);
    expect(indices.length).toBeLessThan(40);
    expect(indices.every((index) => index >= 0 && index < 10_000)).toBe(true);
  });
  it("视口外的键盘焦点和拖拽源继续存在，保持次序且不重复", () => {
    const indices = fileTreeWindow(10_000, 0, 500, 35.2, [2, 9999, 5000, 9999, -1]);
    expect(indices).toContain(2);
    expect(indices).toContain(5000);
    expect(indices).toContain(9999);
    expect(indices.length).toBeLessThan(40);
    expect(indices).toEqual([...new Set(indices)].sort((a, b) => a - b));
    expect(indices[0]).toBe(0);
  });
  it("结果缩短或窗口尚未测量时仍有有效行，不生成越界索引", () => {
    const indices = fileTreeWindow(200, 999_999, 0, 35.2, [500]);
    expect(indices).toContain(199);
    expect(indices.every((index) => index >= 0 && index < 200)).toBe(true);
  });
  it("逐屏滚动能覆盖全部结果，末页没有遗漏", () => {
    const reached = new Set<number>();
    for (let top = 0; top < 35.2 * 10_000; top += 500)
      for (const index of fileTreeWindow(10_000, top, 500, 35.2, [])) reached.add(index);
    expect(reached.size).toBe(10_000);
    expect(reached.has(9999)).toBe(true);
  });
});
