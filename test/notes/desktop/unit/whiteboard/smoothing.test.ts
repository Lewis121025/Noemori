import { expect, it } from "vitest";
import { InkSmoother } from "@reader/shared/whiteboard/smoothing";
import { BOARD_COORDINATE_LIMIT, type InkPoint } from "@reader/shared/whiteboard/model";
import { fitShape } from "@reader/shared/whiteboard/fitting";

const p = (x: number, y = 0): InkPoint => ({ x, y, pressure: 0.5 });
const rms = (points: readonly InkPoint[]) =>
  Math.sqrt(points.reduce((sum, point) => sum + point.y ** 2, 0) / points.length);

it.each([60, 120, 240].flatMap((rate) => [6, 9, 12].map((frequency) => [rate, frequency])))(
  "%s Hz采样、%s Hz手抖下显著衰减，笔尖、原始压力和首点保持精确",
  (rate, frequency) => {
    const raw = Array.from({ length: rate * 2 + 1 }, (_, i) =>
      p((100 * i) / rate, 6 * Math.sin((2 * Math.PI * frequency * i) / rate)),
    );
    const filter = new InkSmoother(raw[0]!, 1, 0);
    for (let i = 1; i < raw.length; i++) filter.push(raw[i]!, (1000 * i) / rate);
    expect(rms(filter.points.slice(rate / 3, -1))).toBeLessThan(
      rms(raw.slice(rate / 3, -1)) * 0.55,
    );
    expect(filter.points[0]).toEqual(raw[0]);
    expect(filter.points.at(-1)).toEqual(raw.at(-1));
    expect(filter.points.map((point) => point.pressure)).toEqual(
      raw.map((point) => point.pressure),
    );
  },
);

it("快速移动的主体滞后不超过8 CSS像素，静态快照消除单向拖尾", () => {
  const raw = Array.from({ length: 241 }, (_, i) => p((600 * i) / 120));
  const filter = new InkSmoother(raw[0]!, 1, 0);
  for (let i = 1; i < raw.length; i++) filter.push(raw[i]!, (1000 * i) / 120);
  expect(filter.motion.every((point, i) => Math.abs(point.x - raw[i]!.x) <= 8 + 1e-8)).toBe(true);
  const snapshot = filter.snapshot();
  expect(
    snapshot.slice(60, -60).every((point, i) => Math.abs(point.x - raw[i + 60]!.x) < 0.3),
  ).toBe(true);
});

it.each([60, 180, 420])("%s像素每秒的连续圆弧保留曲率，静态双向平滑不把圆缩成小圈", (speed) => {
  const radius = 80,
    count = Math.ceil(((2 * Math.PI * radius) / speed) * 120);
  const raw = Array.from({ length: count + 1 }, (_, i) =>
    p(radius * Math.cos((i * 2 * Math.PI) / count), radius * Math.sin((i * 2 * Math.PI) / count)),
  );
  const filter = new InkSmoother(raw[0]!, 1, 0);
  for (let i = 1; i <= count; i++)
    filter.push(raw[i]!, (((1000 * i) / count) * 2 * Math.PI * radius) / speed);
  const errors = filter.snapshot().map((point) => Math.abs(Math.hypot(point.x, point.y) - radius));
  expect(Math.max(...errors)).toBeLessThan(3);
  expect(fitShape(filter.snapshot(), { label: "circle", confidence: 0.99 }, 1, raw)).not.toBeNull();
});

it("明确直角和完整折返保留转向，短笔画不被低通滤波抹掉", () => {
  const raw = [p(0), p(4), p(8), p(8, 4), p(8, 8), p(4, 8), p(0, 8)];
  const filter = new InkSmoother(raw[0]!, 1, 0);
  for (let i = 1; i < raw.length; i++) {
    const oldMotion = [...filter.motion];
    filter.push(raw[i]!, i * 16);
    expect(filter.motion.slice(0, i)).toEqual(oldMotion);
  }
  expect(filter.points[2]).toEqual(raw[2]);
  expect(filter.snapshot()[2]).toEqual(raw[2]);
  const short = new InkSmoother(p(0), 1, 0);
  short.push(p(4, 2), 20);
  short.push(p(2, 5), 40);
  expect(short.points).toEqual([p(0), p(4, 2), p(2, 5)]);
  const retraced = [
    ...Array.from({ length: 41 }, (_, i) => p(i * 4)),
    ...Array.from({ length: 40 }, (_, i) => p(156 - i * 4)),
    ...Array.from({ length: 40 }, (_, i) => p((i + 1) * 4)),
  ];
  const reversal = new InkSmoother(retraced[0]!, 1, 0);
  for (let i = 1; i < retraced.length; i++) reversal.push(retraced[i]!, i * 16);
  expect(reversal.snapshot()[40]).toEqual(p(160));
  expect(reversal.snapshot()[80]).toEqual(p(0));
  expect(
    fitShape(reversal.snapshot(), { label: "line", confidence: 0.99 }, 1, retraced),
  ).toBeNull();
});

it("缺失、同时刻和长间隔采样不伪造频率，非法或倒退时间不修改有效状态", () => {
  const filter = new InkSmoother(p(0), 1, 10);
  filter.push(p(20), 10);
  filter.push(p(40), 1000);
  filter.push(p(60));
  expect(filter.points).toEqual([p(0), p(20), p(40), p(60)]);
  filter.push(p(80), 1100);
  const before = [...filter.points];
  for (const time of [NaN, -1, Infinity, 1000])
    expect(() => filter.push(p(100), time)).toThrow(RangeError);
  expect(filter.points).toEqual(before);
});

it.each([0.01, 1, 8])("%s 倍缩放保持相同屏幕抗抖行为，大世界坐标稳定", (scale) => {
  const first = p(1e6, -1e6);
  const filter = new InkSmoother(first, scale, 0),
    reference = new InkSmoother(p(0), 1, 0);
  for (let i = 1; i <= 240; i++) {
    const point = p((100 * i) / 120, 6 * Math.sin((2 * Math.PI * 12 * i) / 120));
    filter.push(p(first.x + point.x / scale, first.y + point.y / scale), (1000 * i) / 120);
    reference.push(point, (1000 * i) / 120);
  }
  expect(
    filter.points.every(
      (point, i) =>
        Math.hypot(
          (point.x - first.x) * scale - reference.points[i]!.x,
          (point.y - first.y) * scale - reference.points[i]!.y,
        ) < 1e-6,
    ),
  ).toBe(true);
});

it("方向滤波在世界坐标边界处仍产出可保存轨迹，原始坐标不被截断或改写", () => {
  for (const sign of [-1, 1]) {
    const raw = [
      p(sign * (BOARD_COORDINATE_LIMIT - 20)),
      p(sign * (BOARD_COORDINATE_LIMIT - 10)),
      p(sign * BOARD_COORDINATE_LIMIT),
      p(sign * BOARD_COORDINATE_LIMIT),
      p(sign * BOARD_COORDINATE_LIMIT, 10),
      p(sign * BOARD_COORDINATE_LIMIT, 20),
      p(sign * BOARD_COORDINATE_LIMIT, 30),
    ];
    const filter = new InkSmoother(raw[0]!, 1, 0);
    for (let i = 1; i < raw.length; i++) filter.push(raw[i]!, i * 16);
    expect(
      [...filter.points, ...filter.motion, ...filter.snapshot()].every(
        (point) =>
          Math.abs(point.x) <= BOARD_COORDINATE_LIMIT &&
          Math.abs(point.y) <= BOARD_COORDINATE_LIMIT,
      ),
    ).toBe(true);
    expect(raw.at(-1)).toEqual(p(sign * BOARD_COORDINATE_LIMIT, 30));
  }
});

it.each([0.41, 0.93, 1.57])("旋转%s弧度后抗抖和跟笔不因横纵坐标轴改变", (angle) => {
  const rotate = (point: InkPoint) => ({
    ...point,
    x: point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: point.x * Math.sin(angle) + point.y * Math.cos(angle),
  });
  const rotated = new InkSmoother(p(0), 1, 0),
    reference = new InkSmoother(p(0), 1, 0);
  for (let i = 1; i <= 240; i++) {
    const point = p((100 * i) / 120, 6 * Math.sin((2 * Math.PI * 6 * i) / 120));
    rotated.push(rotate(point), (1000 * i) / 120);
    reference.push(point, (1000 * i) / 120);
  }
  expect(
    rotated.points.every(
      (point, i) =>
        Math.hypot(
          point.x - rotate(reference.points[i]!).x,
          point.y - rotate(reference.points[i]!).y,
        ) < 1e-6,
    ),
  ).toBe(true);
});
