import { curveCornerIndices } from "./fitting-corners";
import { circleContour, fitCircleGeometry } from "./fitting-conics";
import { angleAdvance, distance, segmentDistance, resample, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";

/** 圆弧与径向边共用圆心和端点；半圆的直径由同一圆心决定。 */
export type SectorFit = { label: "semicircle" | "sector"; points: FitPoint[]; parameters: number };

/**
 * 按真实切线跳变分段，在统一圆参数下联合拟合圆弧与径向直边。
 * @param sampled 有限等弧长归一化闭合轮廓。
 * @param uncertainty 归一化位置不确定性。
 * @returns 严格半圆或扇形候选；没有明确直弧接点或圆心证据时返回空数组。
 * @throws 数值运行错误向上传播；调用方仍须验收全观测、覆盖和绕行。
 */
export function fitSectors(sampled: readonly FitPoint[], uncertainty: number): SectorFit[] {
  const source = distance(sampled[0]!, sampled.at(-1)!) < 0.03 ? sampled.slice(0, -1) : sampled;
  const corners = curveCornerIndices(source, true);
  if (corners.length < 2 || corners.length > 3) return [];
  const sections = corners.map((at, i) => {
    const end = corners[(i + 1) % corners.length]!;
    return end > at
      ? source.slice(at, end + 1)
      : [...source.slice(at), ...source.slice(0, end + 1)];
  });
  const result: SectorFit[] = [];
  for (let arcIndex = 0; arcIndex < sections.length; arcIndex++) {
    const arc = sections[arcIndex]!;
    if (arc.length < 25) continue;
    const fit = fitCircleGeometry(resample(arc, 96), uncertainty);
    if (!fit || fit.radius < 0.06 || fit.radius > 2) continue;
    const angles = arc.map((p) => Math.atan2(p.y - fit.center.y, p.x - fit.center.x)),
      sweep = angleAdvance(angles);
    if (sweep === null || Math.abs(sweep) < 0.45 || Math.abs(sweep) > 1.9 * Math.PI) continue;
    const rest = Array.from(
      { length: sections.length - 1 },
      (_, i) => sections[(arcIndex + i + 1) % sections.length]!,
    );
    const semicircle = rest.length === 1;
    if (
      semicircle
        ? Math.abs(Math.abs(sweep) - Math.PI) > 0.18
        : distance(rest[0]!.at(-1)!, fit.center) > 0.07
    )
      continue;
    const data = [...arc, ...rest.flat()],
      arcCount = arc.length,
      firstCount = rest[0]!.length;
    const initial = [
      fit.center.x,
      fit.center.y,
      Math.log(fit.radius),
      angles[0]!,
      ...(semicircle ? [] : [sweep]),
    ];
    const geometry = (p: readonly number[]) => {
      const center = { x: p[0]!, y: p[1]! },
        radius = Math.exp(p[2]!),
        start = p[3]!,
        span = semicircle ? Math.sign(sweep) * Math.PI : p[4]!;
      if (
        !p.every(Number.isFinite) ||
        radius < 0.04 ||
        radius > 2 ||
        Math.abs(span) < 0.4 ||
        Math.abs(span) > 1.9 * Math.PI
      )
        return null;
      const a = { x: center.x + radius * Math.cos(start), y: center.y + radius * Math.sin(start) },
        b = {
          x: center.x + radius * Math.cos(start + span),
          y: center.y + radius * Math.sin(start + span),
        };
      return { center, radius, start, span, a, b };
    };
    const optimized = optimizeGeometry(
      initial,
      (p) => {
        const g = geometry(p);
        return g
          ? data.map((point, i) =>
              i < arcCount
                ? distance(point, g.center) - g.radius
                : semicircle
                  ? segmentDistance(point, g.b, g.a)
                  : i < arcCount + firstCount
                    ? segmentDistance(point, g.b, g.center)
                    : segmentDistance(point, g.center, g.a),
            )
          : null;
      },
      uncertainty,
      0.065,
    );
    const g = optimized ? geometry(optimized) : null;
    if (!g) continue;
    const points = circleContour({ center: g.center, radius: g.radius }, g.start, g.span);
    if (!semicircle) points.push(g.center);
    points.push(points[0]!);
    // 从弧首开始的规范轮廓仍按原方向，起点差由调用方的绕行和整段覆盖验证。
    result.push({
      label: semicircle ? "semicircle" : "sector",
      points,
      parameters: initial.length,
    });
  }
  return result;
}
