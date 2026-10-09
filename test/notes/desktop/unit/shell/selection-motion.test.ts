import { expect, it } from "vitest";
import { advanceMotion } from "@reader/renderer/spatial-motion";

it("相同时间在 60Hz 与 120Hz 下抵达相同位置和速度", () => {
  let sixty = { position: 0, velocity: 0 };
  let oneTwenty = { ...sixty };
  for (let frame = 0; frame < 12; frame += 1) sixty = advanceMotion(sixty, 80, 1 / 60);
  for (let frame = 0; frame < 24; frame += 1) oneTwenty = advanceMotion(oneTwenty, 80, 1 / 120);
  expect(sixty.position).toBeCloseTo(oneTwenty.position, 9);
  expect(sixty.velocity).toBeCloseTo(oneTwenty.velocity, 9);
});

it("快速反向保留位置与速度，最终收敛到最新选择", () => {
  const moving = advanceMotion({ position: 0, velocity: 0 }, 80, 0.08);
  const retargeted = advanceMotion(moving, 0, 0);
  expect(retargeted.position).toBeCloseTo(moving.position, 10);
  expect(retargeted.velocity).toBeCloseTo(moving.velocity, 10);
  const rested = advanceMotion(retargeted, 0, 1);
  expect(Math.abs(rested.position)).toBeLessThan(0.001);
  expect(Math.abs(rested.velocity)).toBeLessThan(0.001);
});

it("从静止状态趋近目标不越界，长帧间隔仍稳定", () => {
  let value = { position: 0, velocity: 0 };
  for (let frame = 0; frame < 60; frame += 1) {
    const next = advanceMotion(value, 40, 1 / 60);
    expect(next.position).toBeGreaterThanOrEqual(value.position);
    expect(next.position).toBeLessThanOrEqual(40);
    value = next;
  }
  expect(advanceMotion(value, 80, 10)).toEqual({ position: 80, velocity: expect.any(Number) });
});

it("拒绝无效测量和负时间", () => {
  expect(() => advanceMotion({ position: 0, velocity: 0 }, NaN, 0.1)).toThrow(RangeError);
  expect(() => advanceMotion({ position: 0, velocity: 0 }, 10, -1)).toThrow(RangeError);
});
