import { describe, expect, it } from "vitest";
import {
  fitViewport,
  hitNode,
  toWorld,
  zoomAt,
  ZOOM_MAX,
} from "@reader/renderer/engine/graph/viewport";

describe("zoomAt", () => {
  it("指针下的世界点缩放前后保持不动，倍数收敛到上限", () => {
    const view = { x: 10, y: 20, k: 1 };
    const before = toWorld(view, 100, 80);
    const zoomed = zoomAt(view, 2, 100, 80);
    expect(zoomed.k).toBe(2);
    expect(toWorld(zoomed, 100, 80)).toEqual(before);
    expect(zoomAt(view, 1000, 0, 0).k).toBe(ZOOM_MAX);
  });
});

describe("fitViewport", () => {
  it("全部节点居中落进画布并留边，小图放大不超过适配上限", () => {
    const view = fitViewport([-100, -50, 100, 50], 448, 248, 24);
    expect(view.k).toBe(2);
    expect(view.x).toBe(224);
    expect(view.y).toBe(124);
    expect(fitViewport([-100, -50, 100, 50], 248, 148, 24).k).toBe(1);
    const dense = fitViewport([-1000, 0, 1000, 0], 400, 400, 0);
    expect(dense.k).toBeCloseTo(0.2);
  });

  it("没有节点时返回画布中心的单位视口", () => {
    expect(fitViewport([], 200, 100)).toEqual({ x: 100, y: 50, k: 1 });
  });
});

describe("hitNode", () => {
  it("命中圆内最近的节点；缩得很小时仍保留最小屏幕命中半径", () => {
    const positions = [0, 0, 10, 0];
    const radii = [6, 6];
    const view = { x: 0, y: 0, k: 1 };
    expect(hitNode(view, positions, radii, 8, 0)).toBe(1);
    expect(hitNode(view, positions, radii, 2, 0)).toBe(0);
    expect(hitNode(view, positions, radii, 0, 30)).toBe(-1);
    const far = { x: 0, y: 0, k: 0.1 };
    expect(hitNode(far, positions, [0.5, 0.5], 0.3, 0)).toBe(0);
  });
});
