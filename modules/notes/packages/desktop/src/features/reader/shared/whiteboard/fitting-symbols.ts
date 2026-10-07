import { curveCornerIndices, contourCrossings } from "./fitting-corners";
import { fitCircleGeometry, circleContour } from "./fitting-conics";
import { fitFreeCurve } from "./fitting-curves";
import { angleAdvance, distance, resample, contourDeviation, type FitPoint } from "./fitting-math";

/** 心形以镜像样条保留轮廓，云形以同一接点上的圆弧保留各个凸瓣。 */
export type SymbolFit = { label: "heart" | "cloud"; points: FitPoint[]; parameters: number };
function heart(
  source: readonly FitPoint[],
  corners: readonly number[],
  uncertainty: number,
): SymbolFit | null {
  if (corners.length !== 2) return null;
  const [first, last] = corners,
    a = source[first!]!,
    b = source[last!]!,
    length = distance(a, b);
  if (length < 0.4) return null;
  const tangent = (at: number) => {
    const before = source[(at + source.length - 6) % source.length]!,
      p = source[at]!,
      after = source[(at + 6) % source.length]!;
    return (p.x - before.x) * (after.y - p.y) - (p.y - before.y) * (after.x - p.x);
  };
  if (tangent(first!) * tangent(last!) >= 0) return null;
  const one = source.slice(first!, last! + 1),
    two = [...source.slice(last!), ...source.slice(0, first! + 1)].reverse(),
    left = resample(one, 192),
    right = resample(two, 192),
    direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const reflect = (p: FitPoint) => {
    const x = p.x - a.x,
      y = p.y - a.y,
      t = x * direction.x + y * direction.y;
    return { x: a.x + 2 * t * direction.x - x, y: a.y + 2 * t * direction.y - y };
  };
  const average = left.map((point, i) => {
    const other = reflect(right[i]!);
    return { x: (point.x + other.x) / 2, y: (point.y + other.y) / 2 };
  });
  average[0] = a;
  average[average.length - 1] = b;
  const symmetry = contourDeviation(right, left.map(reflect));
  if (!symmetry || symmetry.rms > 0.025 || symmetry.maximum > 0.06) return null;
  const fitted = fitFreeCurve(average, average, average, uncertainty, 0.0008);
  if (!fitted) return null;
  const points = [...fitted, ...fitted.slice(0, -1).reverse().map(reflect)];
  return contourCrossings(points) === 0 ? { label: "heart", points, parameters: 24 } : null;
}
function cloud(
  source: readonly FitPoint[],
  corners: readonly number[],
  uncertainty: number,
): SymbolFit | null {
  if (corners.length < 3 || corners.length > 12) return null;
  const parts = corners.map((at, i) => {
      const end = corners[(i + 1) % corners.length]!;
      return end > at
        ? source.slice(at, end + 1)
        : [...source.slice(at), ...source.slice(0, end + 1)];
    }),
    points: FitPoint[] = [];
  for (const part of parts) {
    if (part.length < 8) return null;
    const fit = fitCircleGeometry(resample(part, 64), uncertainty);
    if (!fit) return null;
    const sweep = angleAdvance(part.map((p) => Math.atan2(p.y - fit.center.y, p.x - fit.center.x)));
    if (sweep === null || Math.abs(sweep) < 0.6 || Math.abs(sweep) > 1.8 * Math.PI) return null;
    // 固定相邻接点后，圆心只沿弦的垂直平分线投影；每一凸瓣与下一瓣共享同一点。
    const a = part[0]!,
      b = part.at(-1)!,
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dx = b.x - a.x,
      dy = b.y - a.y,
      len = Math.hypot(dx, dy);
    if (len < 0.025) return null;
    const height = ((fit.center.x - mid.x) * -dy + (fit.center.y - mid.y) * dx) / len,
      center = { x: mid.x - (height * dy) / len, y: mid.y + (height * dx) / len },
      radius = distance(center, a),
      angle = Math.atan2(a.y - center.y, a.x - center.x),
      end = Math.atan2(b.y - center.y, b.x - center.x);
    let span = end - angle;
    while (Math.sign(sweep) * span < 0) span += Math.sign(sweep) * 2 * Math.PI;
    const arc = circleContour({ center, radius }, angle, span);
    arc[0] = a;
    arc[arc.length - 1] = b;
    const error = contourDeviation(part, arc);
    if (!error || error.rms > 0.015 || error.maximum > 0.04) return null;
    points.push(...arc.slice(0, -1));
  }
  points.push(points[0]!);
  return contourCrossings(points) === 0
    ? { label: "cloud", points, parameters: corners.length * 3 }
    : null;
}
/**
 * 只在闭合轮廓存在真实尖接点、镜像或圆弧凸瓣证据时规范心/云，其他自由轮廓仍保形。
 * @param sampled 等弧长归一化轮廓。
 * @param uncertainty 归一化定位不确定性。
 * @returns 结构成立的候选；没有语义形状证据时返回空数组，不抛异常。
 */
export function fitSymbols(sampled: readonly FitPoint[], uncertainty: number): SymbolFit[] {
  const source = distance(sampled[0]!, sampled.at(-1)!) < 0.03 ? sampled.slice(0, -1) : sampled,
    corners = curveCornerIndices(source, true);
  return [heart(source, corners, uncertainty), cloud(source, corners, uncertainty)].filter(
    (fit): fit is SymbolFit => fit !== null,
  );
}
