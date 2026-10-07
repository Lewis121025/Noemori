import { polygonDistance } from "./fitting-polygon-distance";
import { straightEvidence } from "./fitting-straight-evidence";
import { circleContour } from "./fitting-conics";
import { angleAdvance, distance, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";

/** 规则多边形的等半径圆角采用内缩多边形与圆盘的Minkowski和，接点严格相切。 */
export type RoundedPolygonFit = {
  label: "rounded-polygon";
  points: FitPoint[];
  parameters: number;
};
function geometry(p: readonly number[], count: number) {
  const radius = Math.exp(p[2]!),
    fillet = (radius * Math.cos(Math.PI / count)) / (1 + Math.exp(-p[4]!)),
    inner = radius - fillet / Math.cos(Math.PI / count);
  if (!p.every(Number.isFinite) || radius < 0.08 || radius > 2 || fillet < 0.012 || inner < 0.025)
    return null;
  const center = { x: p[0]!, y: p[1]! },
    vertices = Array.from({ length: count }, (_, i) => {
      const angle = p[3]! + (i * 2 * Math.PI) / count;
      return { x: center.x + inner * Math.cos(angle), y: center.y + inner * Math.sin(angle) };
    });
  return { center, vertices, fillet, angle: p[3]! };
}
/**
 * 对圆角正多边形做精确边界距离的联合优化，边数由轮廓的旋转谐波提供候选。
 * @param sampled 等弧长有限归一化闭合轮廓。
 * @param observations 完整真实观测，仅约束最大偏差。
 * @param uncertainty 归一化定位不确定性。
 * @returns 等角等边且圆角相切的候选；非周期结构仍由通用曲线保形处理。
 * @throws 数值错误传播，调用方验收完整覆盖与绕行。
 */
export function fitRoundedPolygons(
  sampled: readonly FitPoint[],
  observations: readonly FitPoint[],
  uncertainty: number,
): RoundedPolygonFit[] {
  const center = {
      x: sampled.reduce((sum, p) => sum + p.x, 0) / sampled.length,
      y: sampled.reduce((sum, p) => sum + p.y, 0) / sampled.length,
    },
    polar = sampled.map((p) => ({
      radius: distance(p, center),
      angle: Math.atan2(p.y - center.y, p.x - center.x),
    }));
  const mean = polar.reduce((s, p) => s + p.radius, 0) / polar.length,
    result: RoundedPolygonFit[] = [];
  const sweep = angleAdvance(polar.map((p) => p.angle));
  if (sweep === null || Math.abs(Math.abs(sweep) - 2 * Math.PI) > 0.4) return [];
  const starts = Array.from({ length: 7 }, (_, i) => i + 3)
    .filter((n) => n !== 4)
    .map((count) => {
      const x = polar.reduce((s, p) => s + (p.radius - mean) * Math.cos(count * p.angle), 0),
        y = polar.reduce((s, p) => s + (p.radius - mean) * Math.sin(count * p.angle), 0);
      return { count, angle: Math.atan2(y, x) / count, evidence: Math.hypot(x, y) / polar.length };
    })
    .filter((s) => s.evidence > 0.004)
    .sort((a, b) => b.evidence - a.evidence)
    .slice(0, 2);
  const data = [...sampled, ...observations];
  for (const start of starts)
    for (const fraction of [0.2, 0.5]) {
      const initial = [
        center.x,
        center.y,
        Math.log(Math.max(...polar.map((p) => p.radius)) + 0.02),
        start.angle,
        Math.log(fraction / (1 - fraction)),
      ];
      const fitted = optimizeGeometry(
          initial,
          (p) => {
            const g = geometry(p, start.count);
            return g ? data.map((point) => polygonDistance(point, g.vertices) - g.fillet) : null;
          },
          uncertainty,
          0.065,
          undefined,
          undefined,
          sampled.length,
        ),
        g = fitted ? geometry(fitted, start.count) : null;
      if (!g) continue;
      const straights = g.vertices.map((vertex, i) => {
        const angle = g.angle + (i * 2 * Math.PI) / start.count + Math.PI / start.count,
          next = g.vertices[(i + 1) % start.count]!;
        return [
          { x: vertex.x + g.fillet * Math.cos(angle), y: vertex.y + g.fillet * Math.sin(angle) },
          { x: next.x + g.fillet * Math.cos(angle), y: next.y + g.fillet * Math.sin(angle) },
        ];
      });
      if (straights.some((edge) => !straightEvidence(sampled, edge[0]!, edge[1]!))) continue;
      let points = g.vertices.flatMap((vertex, i) =>
        circleContour(
          { center: vertex, radius: g.fillet },
          g.angle + (i * 2 * Math.PI) / start.count - Math.PI / start.count,
          (2 * Math.PI) / start.count,
        ).filter((_, j) => j % Math.max(1, Math.floor(start.count / 2)) === 0),
      );
      points.push(points[0]!);
      if (sweep < 0) points = points.reverse();
      result.push({ label: "rounded-polygon", points, parameters: 6 });
    }
  return result;
}
