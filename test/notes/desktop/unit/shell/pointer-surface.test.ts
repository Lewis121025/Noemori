import { expect, it } from "vitest";
import {
  createPointerSurface,
  pointerContour,
  pointerSurface,
  samplePointerFlow,
  type PointerFlow,
} from "@reader/renderer/pointer-surface";

const resting: PointerFlow = { x: 0, y: 0, dx: 0, dy: 0, settled: true };

it("相反移动方向产生不同轮廓，停顿后有一次轻微的反向形变", () => {
  const right = samplePointerFlow(resting, { x: 2, y: 0 }, 80);
  const left = samplePointerFlow(resting, { x: -2, y: 0 }, 80);
  expect(pointerContour(right).wake.x).toBeLessThan(0);
  expect(pointerContour(left).wake.x).toBeGreaterThan(0);
  const recoil = samplePointerFlow({ ...resting, x: 1 }, { x: 0, y: 0 }, 120);
  expect(recoil.x).toBeLessThan(0);
  expect(Math.abs(recoil.x)).toBeLessThan(0.12);
});

it("相邻控件之间由光标连续插值，反向输入不保留错误方向的惯性", () => {
  const bounds = [
    { x: 40, y: 0, width: 64, height: 30 },
    { x: 0, y: 0, width: 32, height: 30 },
  ];
  const path = createPointerSurface(bounds)!;
  expect(bounds[0]!.x).toBe(40);
  const right = pointerSurface(path, { x: 60, y: 15 }, 0)!;
  expect(right.x + right.width / 2).toBeCloseTo(60);
  const left = pointerSurface(path, { x: 30, y: 15 }, 0.12)!;
  expect(left.x + left.width / 2).toBeCloseTo(30);
  expect(left.width).toBeGreaterThan(32);
  expect(left.height).toBeLessThan(30);
});

it("纵向菜单和嵌套文件行沿真实路径移动，停下回收尺寸而不改变中心", () => {
  const path = createPointerSurface([
    { x: 0, y: 0, width: 180, height: 30 },
    { x: 16, y: 40, width: 164, height: 30 },
  ])!;
  expect(path.axis).toBe("y");
  const moving = pointerSurface(path, { x: 98, y: 35 }, 0.1)!;
  const resting = pointerSurface(path, { x: 98, y: 35 }, 0)!;
  expect(moving.y + moving.height / 2).toBeCloseTo(35);
  expect(resting.y + resting.height / 2).toBeCloseTo(35);
  expect(moving.height).toBeGreaterThan(resting.height);
  expect(moving.width).toBeLessThan(resting.width);
});

it("空路径和远离控件的空白区域没有反馈，边缘伸展保持有界", () => {
  expect(createPointerSurface([])).toBeNull();
  const path = createPointerSurface([{ x: 0, y: 0, width: 32, height: 30 }])!;
  expect(pointerSurface(path, { x: 80, y: 15 }, 0)).toBeNull();
  const value = pointerSurface(path, { x: 25, y: 15 }, 0.12)!;
  expect(value.width).toBeCloseTo(32 * 1.12);
  expect(value.x + value.width / 2).toBe(25);
});

it("拒绝退化几何和非有限的光标输入", () => {
  expect(() => createPointerSurface([{ x: 0, y: 0, width: 0, height: 30 }])).toThrow(RangeError);
  const path = createPointerSurface([{ x: 0, y: 0, width: 32, height: 30 }])!;
  expect(() => pointerSurface(path, { x: NaN, y: 15 }, 0)).toThrow(RangeError);
  expect(() => pointerSurface(path, { x: 0, y: 15 }, 0.2)).toThrow(RangeError);
});

it("经过宽窄交接的控件中心时尺寸变化平缓，不产生尖锐转折", () => {
  const path = createPointerSurface([
    { x: 0, y: 0, width: 32, height: 30 },
    { x: 40, y: 0, width: 64, height: 30 },
    { x: 112, y: 0, width: 32, height: 30 },
  ])!;
  for (const x of [71.5, 72, 72.5]) {
    const value = pointerSurface(path, { x, y: 15 }, 0)!;
    expect(value.x + value.width / 2).toBeCloseTo(x);
    expect(Math.abs(value.width - 64)).toBeLessThan(0.03);
  }
});

it("形变保留急转动量，60Hz 与 120Hz 的相同时间给出相同形状", () => {
  const velocity = { x: 2, y: 1 };
  const slow = samplePointerFlow(resting, velocity, 1000 / 60);
  const fast = samplePointerFlow(
    samplePointerFlow(resting, velocity, 1000 / 120),
    velocity,
    1000 / 120,
  );
  expect(fast.x).toBeCloseTo(slow.x, 10);
  expect(fast.y).toBeCloseTo(slow.y, 10);
  expect(fast.dx).toBeCloseTo(slow.dx, 10);
  expect(fast.dy).toBeCloseTo(slow.dy, 10);
  const turning = samplePointerFlow(fast, { x: -2, y: -1 }, 8);
  expect(Math.abs(turning.x - fast.x)).toBeLessThan(0.1);
  expect(turning.dx).toBeLessThan(fast.dx);
  let value = fast;
  for (let frame = 0; frame < 72; frame += 1)
    value = samplePointerFlow(value, { x: 0, y: 0 }, 1000 / 120);
  expect(value).toEqual(resting);
});

it("形变计时拒绝非有限或越界输入，零时间不会产生位移", () => {
  expect(samplePointerFlow(resting, { x: 2, y: 0 }, 0).x).toBe(0);
  expect(() => samplePointerFlow(resting, { x: Infinity, y: 0 }, 8)).toThrow(RangeError);
  expect(() => samplePointerFlow({ ...resting, x: 2 }, { x: 0, y: 0 }, 8)).toThrow(RangeError);
  expect(() => samplePointerFlow(resting, { x: 0, y: 0 }, -1)).toThrow(RangeError);
  expect(() => samplePointerFlow({ ...resting, dx: NaN }, { x: 0, y: 0 }, 8)).toThrow(RangeError);
});

it("斜向轮廓包含倾斜与尾部，持续往返保持有界，静止后尾部完全消退", () => {
  let flow = resting;
  for (let frame = 0; frame < 240; frame += 1) {
    flow = samplePointerFlow(flow, { x: frame % 24 < 12 ? 3 : -3, y: 1 }, 8);
    const contour = pointerContour(flow);
    expect(contour.stretch).toBeLessThanOrEqual(0.12);
    expect(contour.wake.opacity).toBeLessThanOrEqual(0.55);
    expect(Math.hypot(contour.wake.x, contour.wake.y)).toBeLessThanOrEqual(5.2 + 1e-10);
  }
  expect(pointerContour(flow).body[1]).not.toBe(0);
  expect(pointerContour(resting).wake.opacity).toBe(0);
  expect(pointerContour(resting).body).toEqual([0.9, 0, 0, 0.9]);
});
