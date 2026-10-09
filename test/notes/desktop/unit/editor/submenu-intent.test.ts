import { expect, it } from "vitest";
import { approachesSubmenu } from "@reader/renderer/editor/formatting/submenu-intent";

it("朝右侧子菜单的斜向路径保留目标，垂直或远离目标的移动即时切换", () => {
  const bounds = { left: 300, right: 450, top: 100, bottom: 300 };
  const origin = { x: 200, y: 110 };
  expect(approachesSubmenu(origin, { x: 225, y: 150 }, bounds)).toBe(true);
  expect(approachesSubmenu(origin, { x: 200, y: 150 }, bounds)).toBe(false);
  expect(approachesSubmenu(origin, { x: 190, y: 110 }, bounds)).toBe(false);
  expect(approachesSubmenu(origin, { x: 225, y: 190 }, bounds)).toBe(false);
});

it("子菜单在窄窗口翻到左侧时沿用真实边界，越过近侧边缘不延迟父项", () => {
  const bounds = { left: 50, right: 200, top: 100, bottom: 300 };
  const origin = { x: 300, y: 110 };
  expect(approachesSubmenu(origin, { x: 275, y: 150 }, bounds)).toBe(true);
  expect(approachesSubmenu(origin, { x: 310, y: 110 }, bounds)).toBe(false);
  expect(approachesSubmenu(origin, { x: 190, y: 180 }, bounds)).toBe(false);
});

it("空边界、重叠锚点或非有限坐标不产生悬停等待", () => {
  const bounds = { left: 300, right: 450, top: 100, bottom: 300 };
  expect(approachesSubmenu({ x: NaN, y: 110 }, { x: 225, y: 150 }, bounds)).toBe(false);
  expect(
    approachesSubmenu({ x: 200, y: 110 }, { x: 225, y: 150 }, { ...bounds, bottom: 100 }),
  ).toBe(false);
  expect(approachesSubmenu({ x: 310, y: 110 }, { x: 325, y: 150 }, bounds)).toBe(false);
});
