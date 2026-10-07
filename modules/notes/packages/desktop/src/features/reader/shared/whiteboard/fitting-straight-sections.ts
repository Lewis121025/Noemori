import { pilotContour, noiseScale } from "./fitting-noise";
import { fitLineGeometry, type LineGeometry } from "./fitting-lines";
import { distance, principalLine, type FitPoint } from "./fitting-math";

/** 长直段使用独立观测和TLS支持线，不把轮廓采样得到的短弦当成真实直边。 */
export type StraightSection = { points: FitPoint[]; line: LineGeometry };
/**
 * 从闭合轮廓提取足够长且切线一致的直段，为一般圆角多边形提供虚拟顶点初值。
 * @param points 等弧长有限归一化轮廓，不含重复末点。
 * @param uncertainty 定位不确定性，只用于鲁棒支持线估计。
 * @returns 按原顺序的直段；连续弯曲或短直段不会制造多边形身份。
 * @throws 数值错误传播。
 */
export function straightSections(
  points: readonly FitPoint[],
  uncertainty: number,
): StraightSection[] {
  const guide = pilotContour(points, true, 6),
    noise = noiseScale(points, true),
    sample = (i: number) => guide[(i + points.length) % points.length]!;
  const straight = points.map((_, i) => {
    const a = sample(i - 8),
      b = sample(i),
      c = sample(i + 8),
      left = Math.atan2(b.y - a.y, b.x - a.x),
      right = Math.atan2(c.y - b.y, c.x - b.x);
    if (Math.abs(Math.atan2(Math.sin(right - left), Math.cos(right - left))) > 0.12) return false;
    const part = Array.from({ length: 17 }, (_, j) => sample(i + j - 8)),
      line = principalLine(part);
    if (!line) return false;
    return (
      Math.sqrt(
        part.reduce(
          (sum, p) =>
            sum +
            ((p.y - line.center.y) * Math.cos(line.angle) -
              (p.x - line.center.x) * Math.sin(line.angle)) **
              2,
          0,
        ) / part.length,
      ) < Math.max(0.0015, noise * 0.5)
    );
  });
  const gap = straight.findIndex((value) => !value);
  if (gap < 0) return [];
  const groups: FitPoint[][] = [];
  let current: FitPoint[] = [];
  for (let step = 1; step <= points.length; step++) {
    const i = (gap + step) % points.length;
    if (straight[i]) current.push(points[i]!);
    else if (current.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups.flatMap((part) => {
    if (part.length < 7 || distance(part[0]!, part.at(-1)!) < 0.065) return [];
    const line = fitLineGeometry(part, uncertainty);
    return line ? [{ points: part, line }] : [];
  });
}
