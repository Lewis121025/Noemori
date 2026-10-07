import { describe, expect, it, vi } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import { contourCrossings } from "@reader/shared/whiteboard/fitting-corners";
import {
  contourDeviation,
  resample,
  segmentDistance,
} from "@reader/shared/whiteboard/fitting-math";
import { emptyWhiteboard, type InkPoint } from "@reader/shared/whiteboard/model";
import { parseShapeFit } from "@reader/shared/whiteboard/recognition";
import { WhiteboardInput } from "@reader/renderer/whiteboard/input";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const wave = (t: number) => p(320 * t, 90 * Math.sin(2 * Math.PI * t));

/** 母曲线与抖动独立定义，检查恢复真实轮廓，避免只验证输出比输入更光滑。 */
function samples(shape: (t: number) => InkPoint, noise = 0, count = 385): InkPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1),
      point = shape(t),
      envelope = Math.sin(Math.PI * t);
    return p(
      point.x + noise * envelope * Math.sin(43 * Math.PI * t),
      point.y + noise * envelope * Math.sin(57 * Math.PI * t + 0.7),
    );
  });
}

function bending(points: readonly InkPoint[]): number {
  const contour = resample(points, 192);
  return contour.slice(1, -1).reduce((sum, point, i) => {
    const before = contour[i]!,
      after = contour[i + 2]!;
    return sum + (after.x - 2 * point.x + before.x) ** 2 + (after.y - 2 * point.y + before.y) ** 2;
  }, 0);
}

describe("停笔后的通用曲线拟合", () => {
  it.each([0, 3, 7])("S形曲线恢复整体轮廓并消除%s像素抖动", (noise) => {
    const source = samples(wave, noise),
      original = structuredClone(source),
      result = repairShape(source, 1);
    expect(result?.label).toBe("curve");
    expect(result!.points[0]).toEqual(source[0]);
    expect(result!.points.at(-1)).toEqual(source.at(-1));
    const error = contourDeviation(samples(wave), result!.points)!;
    expect(error.rms).toBeLessThan(noise === 0 ? 0.4 : noise * 0.55);
    expect(error.maximum).toBeLessThan(noise === 0 ? 1 : noise);
    if (noise > 0) expect(bending(result!.points)).toBeLessThan(bending(source) * 0.25);
    expect(source).toEqual(original);
    expect(parseShapeFit(result)).toEqual(result);
  });

  it("开口椭圆弧保留开口和轴比例，不强行补圆或闭合", () => {
    const shape = (t: number) =>
      p(140 * Math.cos(1.5 * Math.PI * t), 55 * Math.sin(1.5 * Math.PI * t));
    const source = samples(shape, 3),
      result = repairShape(source, 1);
    expect(result?.label).toBe("curve");
    expect(result!.points[0]).toEqual(source[0]);
    expect(result!.points.at(-1)).toEqual(source.at(-1));
    expect(contourDeviation(samples(shape), result!.points)!.rms).toBeLessThan(2);
  });

  it("不规则闭合曲线保持闭合，并在起笔接缝保持平滑", () => {
    const shape = (t: number) => {
      const angle = t * 2 * Math.PI,
        radius = 95 + 25 * Math.cos(3 * angle);
      return p(radius * Math.cos(angle), radius * Math.sin(angle));
    };
    const source = samples(shape, 3);
    source[source.length - 1] = source[0]!;
    const result = repairShape(source, 1);
    expect(result?.label).toBe("curve");
    expect(result!.points[0]).toEqual(result!.points.at(-1));
    expect(contourDeviation(samples(shape), result!.points)!.rms).toBeLessThan(2);
    const points = result!.points,
      start = points[0]!,
      next = points[1]!,
      before = points.at(-2)!;
    const incoming = Math.atan2(start.y - before.y, start.x - before.x),
      outgoing = Math.atan2(next.y - start.y, next.x - start.x);
    expect(
      Math.abs(Math.atan2(Math.sin(outgoing - incoming), Math.cos(outgoing - incoming))),
    ).toBeLessThan(0.2);
  });

  it("不规则曲线两端接近但存在可见开口时，保留开口及两个真实端点", () => {
    const shape = (t: number) => {
      const angle = t * (2 * Math.PI - 0.02),
        radius = 95 + 25 * Math.cos(3 * angle);
      return p(radius * Math.cos(angle), radius * Math.sin(angle));
    };
    const source = samples(shape),
      result = repairShape(source, 1);
    expect(result?.label).toBe("curve");
    expect(result!.points[0]).toEqual(source[0]);
    expect(result!.points.at(-1)).toEqual(source.at(-1));
    expect(
      Math.hypot(
        result!.points[0]!.x - result!.points.at(-1)!.x,
        result!.points[0]!.y - result!.points.at(-1)!.y,
      ),
    ).toBeGreaterThan(2);
  });

  it("弯曲边之间的真实尖角保持位置及转向，不能被统一磨圆", () => {
    const shape = (t: number) => {
      if (t <= 0.5) return p(200 * t, 100 * (2 * t) ** 2);
      const u = 2 * t - 1;
      return p(100 + 100 * u, 100 - 120 * u + 20 * u * u);
    };
    const result = repairShape(samples(shape, 2), 1);
    expect(result?.label).toBe("curve");
    const points = result!.points,
      at = points.reduce((best, point, i) => (point.y > points[best]!.y ? i : best), 0);
    expect(Math.hypot(points[at]!.x - 100, points[at]!.y - 100)).toBeLessThan(3);
    const before = points[at - 1]!,
      peak = points[at]!,
      after = points[at + 1]!;
    const first = Math.atan2(peak.y - before.y, peak.x - before.x),
      second = Math.atan2(after.y - peak.y, after.x - peak.x);
    expect(
      Math.abs(Math.atan2(Math.sin(second - first), Math.cos(second - first))),
    ).toBeGreaterThan(1.1);
    expect(contourDeviation(samples(shape), points)!.rms).toBeLessThan(1.5);
  });

  it("自交曲线保持同一交叉与两个环，不能用平滑消掉环", () => {
    const shape = (t: number) => {
      const angle = 0.37 + 2 * Math.PI * t;
      return p(110 * Math.sin(angle), 65 * Math.sin(2 * angle));
    };
    const source = samples(shape, 2);
    source[source.length - 1] = source[0]!;
    const result = repairShape(source, 1);
    expect(result?.label).toBe("curve");
    expect(contourCrossings(result!.points)).toBe(1);
    expect(result!.points[0]).toEqual(result!.points.at(-1));
    expect(contourDeviation(samples(shape), result!.points)!.rms).toBeLessThan(2);
  });

  it("孤立真实小环不能抬高整条曲线的噪声预算，无法保形时应拒绝", () => {
    const source = samples(
      (t) => {
        const point = wave(t),
          envelope = Math.exp(-(((t - 0.37) / 0.008) ** 2)),
          angle = (2 * Math.PI * (t - 0.37)) / 0.017;
        return p(
          point.x + 3.5 * envelope * Math.cos(angle),
          point.y + 3.5 * envelope * Math.sin(angle),
        );
      },
      0,
      769,
    );
    const crossings = contourCrossings(source);
    expect(crossings).toBeGreaterThan(0);
    const result = repairShape(source, 1);
    if (result) {
      expect(result.label).toBe("curve");
      expect(contourCrossings(result.points)).toBe(crossings);
    }
  });

  it.each([0.2, 1, 4])("相同可见曲线在缩放%s、大世界坐标和反向绘制下保持等价", (scale) => {
    const source = samples(wave, 4);
    const base = repairShape(source, 1)!;
    const transformed = source.map((point) =>
      p(8_000_000 + point.x / scale, -7_000_000 + point.y / scale),
    );
    const result = repairShape(transformed, scale)!;
    expect(result.label).toBe("curve");
    const restored = result.points.map((point) =>
      p((point.x - 8_000_000) * scale, (point.y + 7_000_000) * scale),
    );
    expect(contourDeviation(base.points, restored)!.maximum).toBeLessThan(0.05);
    const reversed = repairShape([...source].reverse(), 1)!;
    expect(reversed.label).toBe("curve");
    expect(contourDeviation(base.points, reversed.points)!.maximum).toBeLessThan(0.1);
  });

  it("局部采样密度变化不能给曲线局部加权，完整原始观测仍约束修复", () => {
    const source = samples(wave, 4),
      base = repairShape(source, 1)!;
    const dense = source.flatMap((point, i) =>
      Array.from({ length: i > 80 && i < 180 ? 9 : 1 }, () => point),
    );
    const result = repairShape(dense, 1)!;
    expect(result.label).toBe("curve");
    expect(contourDeviation(base.points, result.points)!.maximum).toBeLessThan(0.1);
    expect(repairShape(source, 1, [...source, p(160, 500)])).toBeNull();
    expect(repairShape(source, 1, [...source, p(NaN, 0)])).toBeNull();
  });

  it("大范围重描、重复圈和共线涂划不能绕过原有拒绝约束", () => {
    const source = samples(wave);
    const retraced = [
      ...source.slice(0, 240),
      ...source.slice(80, 239).reverse(),
      ...source.slice(81),
    ];
    expect(repairShape(retraced, 1)).toBeNull();
    const loop = samples((t) =>
      p(100 * Math.cos(2 * Math.PI * t), 100 * Math.sin(2 * Math.PI * t)),
    );
    expect(repairShape([...loop, ...loop.slice(1)], 1)).toBeNull();
    expect(repairShape([p(0, 0), p(100, 0), p(0, 0), p(100, 0)], 1)).toBeNull();
  });

  it("规则图形仍由其几何拟合处理，曲线不能改变已成立的图形类别", () => {
    expect(
      repairShape(
        samples((t) => p(200 * t, Math.sin(t * 40) * 2)),
        1,
      )?.label,
    ).toBe("line");
    expect(
      repairShape(
        samples((t) => p(100 * Math.cos(t * 2 * Math.PI), 100 * Math.sin(t * 2 * Math.PI)), 2),
        1,
      )?.label,
    ).toBe("circle");
    expect(
      repairShape(
        samples((t) => p(130 * Math.cos(t * 2 * Math.PI), 65 * Math.sin(t * 2 * Math.PI)), 2),
        1,
      )?.label,
    ).toBe("ellipse");
  });

  it("曲线停笔预览、抬笔提交和撤销重做使用同一轮廓，并保存完整源笔迹", async () => {
    const source = samples(wave, 5),
      board = new WhiteboardInput(emptyWhiteboard(), vi.fn(), async (request) =>
        repairShape(request.points, request.scale, request.observations),
      );
    board.begin(source[0]!);
    for (const point of source.slice(1)) board.update(point);
    const accepted = [...board.points];
    expect(await board.hold()).toBe(true);
    expect(board.correctedLabel).toBe("curve");
    const preview = [...board.points];
    board.finish();
    const stroke = board.document.strokes[0]!;
    expect(stroke.points).toEqual(preview);
    expect(stroke.source).toEqual(accepted);
    expect(
      preview.every((point) =>
        source.slice(1).some((end, i) => segmentDistance(point, source[i]!, end) < 24),
      ),
    ).toBe(true);
    board.applyHistory("undo");
    expect(board.document.strokes).toHaveLength(0);
    board.applyHistory("redo");
    expect(board.document.strokes[0]!.points).toEqual(preview);
  });

  it("停笔区域归并后，原始闭合证据仍应保持不规则曲线闭合", async () => {
    const source = samples((t) => {
      const angle = 0.27 + t * 2 * Math.PI,
        radius = 95 + 25 * Math.cos(3 * angle);
      return p(350 + radius * Math.cos(angle), 250 + radius * Math.sin(angle));
    }, 3);
    source[source.length - 1] = source[0]!;
    const board = new WhiteboardInput(emptyWhiteboard(), vi.fn(), async (request) =>
      repairShape(request.points, request.scale, request.observations),
    );
    board.begin(source[0]!);
    for (const point of source.slice(1)) board.update(point);
    expect(await board.hold()).toBe(true);
    expect(board.correctedLabel).toBe("curve");
    expect(board.points.at(-1)).toEqual(board.points[0]);
  });
});
