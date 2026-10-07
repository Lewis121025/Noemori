import { circleContour } from "./fitting-conics";
import { straightSections } from "./fitting-straight-sections";
import { straightEvidence } from "./fitting-straight-evidence";
import { polygonDistance } from "./fitting-polygon-distance";
import { optimizeGeometry } from "./fitting-optimization";
import { distance, type FitPoint } from "./fitting-math";
import type { RoundedPolygonFit } from "./fitting-rounded-polygon";

/** 任意凸多边形的圆角共用半径，中心是相邻支持线的角平分线偏移。 */
function filletGeometry(p: readonly number[], count: number) {
  const vertices = Array.from({ length: count }, (_, i) => ({ x: p[2 * i]!, y: p[2 * i + 1]! })),
    radius = Math.exp(p[2 * count]!);
  if (!p.every(Number.isFinite) || radius < 0.012 || radius > 0.25) return null;
  const corners = vertices.map((vertex, i) => {
    const before = vertices[(i + count - 1) % count]!,
      after = vertices[(i + 1) % count]!,
      first = distance(before, vertex),
      second = distance(after, vertex),
      u = { x: (before.x - vertex.x) / first, y: (before.y - vertex.y) / first },
      v = { x: (after.x - vertex.x) / second, y: (after.y - vertex.y) / second },
      half = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y))) / 2;
    if (u.x * v.y - u.y * v.x >= 0 || half < 0.2 || half > 1.5) return null;
    const offset = radius / Math.tan(half),
      bisector = Math.hypot(u.x + v.x, u.y + v.y);
    if (offset > 0.45 * Math.min(first, second) || bisector < 1e-8) return null;
    const center = {
        x: vertex.x + (radius * (u.x + v.x)) / (Math.sin(half) * bisector),
        y: vertex.y + (radius * (u.y + v.y)) / (Math.sin(half) * bisector),
      },
      a = { x: vertex.x + u.x * offset, y: vertex.y + u.y * offset },
      b = { x: vertex.x + v.x * offset, y: vertex.y + v.y * offset };
    return { center, a, b };
  });
  if (corners.some((c) => c === null)) return null;
  return { radius, corners: corners.filter((c) => c !== null) };
}
/**
 * 将真实长直段的支持线交点作为虚拟顶点，联合求任意凸多边形的相切圆角。
 * @param sampled 有限等弧长闭合轮廓。
 * @param observations 全部真实观测，仅约束最大偏差。
 * @param uncertainty 归一化位置不确定性。
 * @returns 不要求等边等角的一般圆角多边形；没有足够直边支持时返回空数组。
 * @throws 数值错误传播，最终仍须验证每段直边、覆盖与绕行。
 */
export function fitFilletPolygons(
  sampled: readonly FitPoint[],
  observations: readonly FitPoint[],
  uncertainty: number,
): RoundedPolygonFit[] {
  let source = [...sampled];
  if (distance(source[0]!, source.at(-1)!) < 0.03) source = source.slice(0, -1);
  const area = source.reduce((sum, p, i) => {
      const q = source[(i + 1) % source.length]!;
      return sum + p.x * q.y - p.y * q.x;
    }, 0),
    reversed = area < 0;
  if (reversed) source.reverse();
  const sections = straightSections(source, uncertainty);
  if (sections.length < 3 || sections.length > 12) return [];
  const vertices: FitPoint[] = [];
  for (let i = 0; i < sections.length; i++) {
    const a = sections[(i + sections.length - 1) % sections.length]!.line,
      b = sections[i]!.line,
      u = { x: Math.cos(a.angle), y: Math.sin(a.angle) },
      v = { x: Math.cos(b.angle), y: Math.sin(b.angle) },
      det = u.x * v.y - u.y * v.x;
    if (Math.abs(det) < 0.08) return [];
    const t = ((b.center.x - a.center.x) * v.y - (b.center.y - a.center.y) * v.x) / det;
    vertices.push({ x: a.center.x + t * u.x, y: a.center.y + t * u.y });
  }
  const data = [...sampled, ...observations],
    result: RoundedPolygonFit[] = [];
  for (const radius of [0.025, 0.06, 0.12]) {
    const initial = [...vertices.flatMap((p) => [p.x, p.y]), Math.log(radius)];
    if (!filletGeometry(initial, vertices.length)) continue;
    const fitted = optimizeGeometry(
        initial,
        (p) => {
          const g = filletGeometry(p, vertices.length);
          return g
            ? data.map(
                (point) =>
                  polygonDistance(
                    point,
                    g.corners.map((c) => c.center),
                  ) - g.radius,
              )
            : null;
        },
        uncertainty,
        0.065,
        undefined,
        undefined,
        sampled.length,
      ),
      g = fitted ? filletGeometry(fitted, vertices.length) : null;
    if (!g) continue;
    if (
      g.corners.some(
        (corner, i) =>
          !straightEvidence(sampled, corner.b, g.corners[(i + 1) % g.corners.length]!.a),
      )
    )
      continue;
    let points = g.corners.flatMap((corner) => {
      const start = Math.atan2(corner.a.y - corner.center.y, corner.a.x - corner.center.x),
        end = Math.atan2(corner.b.y - corner.center.y, corner.b.x - corner.center.x);
      let sweep = end - start;
      while (sweep < 0) sweep += 2 * Math.PI;
      return circleContour({ center: corner.center, radius: g.radius }, start, sweep).filter(
        (_, i) => i % 4 === 0,
      );
    });
    points.push(points[0]!);
    if (reversed) points = points.reverse();
    result.push({ label: "rounded-polygon", points, parameters: initial.length });
  }
  return result;
}
