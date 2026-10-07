import { segmentDistance, type FitPoint } from "./fitting-math";

/**
 * 简单多边形的精确边界有符号距离，凸与凹轮廓共用最近线段和奇偶绕行。
 * @param point 有限归一化观测。
 * @param vertices 至少三个有限顶点，可含重复末点；拓扑由调用方校验。
 * @returns 最近边界距离，内部为负；不抛异常。
 */
export function polygonDistance(point: FitPoint, vertices: readonly FitPoint[]): number {
  let nearest = Infinity,
    inside = false;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!,
      b = vertices[(i + 1) % vertices.length]!;
    nearest = Math.min(nearest, segmentDistance(point, a, b));
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside ? -nearest : nearest;
}
