import { expect, it } from "vitest";
import { advancePause, preparePause, type PauseRegion } from "@reader/shared/whiteboard/pause";
import type { InkPoint } from "@reader/shared/whiteboard/model";

const p = (x: number, y = 0): InkPoint => ({ x, y, pressure: 0.5 });

/** 穷举固定半径圆的两点交会，与增量最小覆盖圆独立核验后缀可行性。 */
function coverable(points: readonly InkPoint[]): boolean {
  const centers = points.map(({ x, y }) => ({ x, y }));
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!,
        b = points[j]!;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        distance = Math.hypot(dx, dy);
      if (distance === 0 || distance > 6) continue;
      const height = Math.sqrt(9 - (distance * distance) / 4);
      for (const sign of [-1, 1])
        centers.push({
          x: (a.x + b.x) / 2 - (sign * height * dy) / distance,
          y: (a.y + b.y) / 2 + (sign * height * dx) / distance,
        });
    }
  return centers.some((center) =>
    points.every((point) => Math.hypot(point.x - center.x, point.y - center.y) <= 3 + 1e-8),
  );
}

function observe(points: InkPoint[], radius = 3) {
  let pause: PauseRegion = { center: points[0]!, enclosing: points[0]!, start: 0, reset: 0 };
  for (let i = 1; i < points.length; i++)
    pause = advancePause(points.slice(0, i + 1), pause, radius);
  return pause;
}

it("区域内微抖保持计时基准，离开区域才更新基准与请求边界", () => {
  const points = [p(100), p(110), p(112.5), p(109.1), p(114)];
  const initial = observe(points.slice(0, 2));
  for (const count of [3, 4]) {
    const inside = advancePause(points.slice(0, count), initial, 3);
    expect(inside.reset).toBe(initial.reset);
    expect(inside.center).toBe(initial.center);
  }
  const next = advancePause(points, initial, 3);
  expect(next).not.toBe(initial);
  expect(next.reset).toBe(4);
  expect(next.start).toBe(1);
});

it("完整停笔簇可自适应覆盖，不能把持续微抖当成不断的新移动", () => {
  const points = Array.from({ length: 97 }, (_, i) => p((40 * i) / 96));
  let pause = observe(points);
  let resets = 0;
  for (let i = 1; i <= 120; i++) {
    points.push(
      p(40 + (2.5 * Math.sin(i * 0.37)) / Math.SQRT2, (2.5 * Math.sin(i * 0.53)) / Math.SQRT2),
    );
    const next = advancePause(points, pause, 3);
    if (next.reset !== pause.reset) resets++;
    pause = next;
  }
  expect(resets).toBeLessThan(10);
  expect(pause.reset).toBeLessThan(points.length - 60);
  const snapshot = preparePause(points, pause, 3).points;
  expect(snapshot.length).toBeLessThan(100);
  expect(Math.hypot(snapshot.at(-1)!.x - 40, snapshot.at(-1)!.y)).toBeLessThan(0.8);
});

it("持续向前的小步移动会持续更新区域，不会让静止区域跟着笔尖无限漂移", () => {
  const points = Array.from({ length: 1001 }, (_, i) => p(i * 0.4));
  const pause = observe(points);
  expect(points.length - 1 - pause.reset).toBeLessThan(9);
  expect(pause.start).toBeGreaterThan(970);
});

it("重心与包围盒不能替代圆形覆盖，旋转后的偏心停笔簇仍能收敛", () => {
  const points = [p(-10), p(0)];
  for (let i = 0; i < 40; i++) {
    const angle = ((i % 3) * 2 * Math.PI) / 3 + Math.PI / 4;
    points.push(p(2.9 * Math.cos(angle), 2.9 * Math.sin(angle)));
  }
  const pause = observe(points);
  expect(pause.start).toBe(1);
  expect(pause.reset).toBeLessThan(8);
  expect(
    points
      .slice(pause.start)
      .every(
        (point) => Math.hypot(point.x - pause.enclosing.x, point.y - pause.enclosing.y) <= 3 + 1e-8,
      ),
  ).toBe(true);
});

it("覆盖圆与最长后缀符合独立穷举判据，包含共线、重复和任意旋转的观测", () => {
  let seed = 92821;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let trial = 0; trial < 100; trial++) {
    const points = [p(-10)];
    let pause: PauseRegion = { center: points[0]!, enclosing: points[0]!, start: 0, reset: 0 };
    for (let i = 1; i < 9; i++) {
      points.push(p((random() - 0.5) * 10, trial % 3 === 0 ? 0 : (random() - 0.5) * 10));
      let expected = pause.start;
      while (!coverable(points.slice(expected))) expected++;
      pause = advancePause(points, pause, 3);
      expect(pause.start).toBe(expected);
      expect(
        points
          .slice(pause.start)
          .every(
            (point) =>
              Math.hypot(point.x - pause.enclosing.x, point.y - pause.enclosing.y) <= 3 + 1e-8,
          ),
      ).toBe(true);
    }
  }
});

it.each([0, -1, Infinity, NaN])("非法半径 %s 在修改静止区域前拒绝", (radius) => {
  const first = p(0);
  const pause: PauseRegion = { center: first, enclosing: first, start: 0, reset: 0 };
  expect(() => advancePause([first], pause, radius)).toThrow(RangeError);
});

it("无新增静止观测时不改变末段和压力，有静止观测时不修改原始采样", () => {
  const points = Array.from({ length: 25 }, (_, i) => p(i * 4, Math.sin(i) * 0.6));
  const pause = observe(points);
  expect(preparePause(points, pause, 3).points).toEqual(points);
  for (let i = 1; i <= 40; i++)
    points.push({ ...points.at(-1)!, x: 96 + 1.7 * Math.sin(i * 1.3), pressure: 0.8 });
  const original = structuredClone(points);
  const snapshot = preparePause(points, observe(points), 3).points;
  expect(snapshot.length).toBeLessThan(points.length);
  expect(snapshot.at(-1)!.pressure).toBeGreaterThan(0.5);
  expect(snapshot.at(-1)!.pressure).toBeLessThanOrEqual(0.8);
  expect(points).toEqual(original);
});

it("慢速单向收笔和真实角点不归并，即使最后几项没有越过计时区域", () => {
  const points = Array.from({ length: 99 }, (_, i) => p((40 * i) / 96));
  const pause = observe(points);
  expect(pause.reset).toBeLessThan(points.length - 1);
  expect(preparePause(points, pause, 3).points).toEqual(points);
  const corner = [...points, p(40, 1), p(40, 2)];
  expect(preparePause(corner, observe(corner), 3).points).toEqual(corner);
});

it("稳定运动已确认停笔时，瞬时大幅末点观测不会否定归并；数量违约拒绝", () => {
  const motion = Array.from({ length: 121 }, (_, i) =>
    p(Math.min(i, 100), i <= 100 ? 0 : Math.sin(i)),
  );
  const pause = observe(motion);
  const geometry = motion.map((point, i) => (i === motion.length - 1 ? p(104, -4) : point));
  const prepared = preparePause(geometry, pause, 3, motion);
  expect(prepared.points.length).toBeLessThan(geometry.length);
  expect(Math.hypot(prepared.points.at(-1)!.x - 100, prepared.points.at(-1)!.y)).toBeLessThan(1);
  expect(() => preparePause(geometry, pause, 3, motion.slice(1))).toThrow(RangeError);
});

it.each([0.01, 1, 64])("按屏幕半径处理缩放 %s，大世界坐标不破坏局部稳定末点", (scale) => {
  const points = Array.from({ length: 49 }, (_, i) => p(1e8 + (40 * i) / (48 * scale), -1e8));
  for (let i = 1; i <= 100; i++)
    points.push(
      p(1e8 + (40 + 1.7 * Math.sin(i * 1.3)) / scale, -1e8 + (1.7 * Math.sin(i * 1.7)) / scale),
    );
  const pause = observe(points, 3 / scale);
  const endpoint = preparePause(points, pause, 3 / scale).points.at(-1)!;
  expect(Math.hypot((endpoint.x - 1e8) * scale - 40, (endpoint.y + 1e8) * scale)).toBeLessThan(0.8);
});
