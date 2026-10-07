import { repairShape } from "./fitting";
import { curveStructure } from "./fitting-curve-structure";
import { noiseScale } from "./fitting-noise";
import { polygonDistance } from "./fitting-polygon-distance";
import { distance, resample, type FitPoint } from "./fitting-math";
import type { SceneFit, SceneFrame } from "./fitting-scene";

/**
 * 嵌套闭合轮廓分别规范，保持孔洞/多层边界独立；不会用一条连接线串起多个环。
 * @param frame 同一场景的完整笔迹与观测。
 * @returns 与当前闭合边界存在严格包含关系的多环候选；接触、自交或开口不关联。
 * @throws 数值错误传播；外层统一验证每笔原始观测。
 */
export function fitNestedContours(frame: SceneFrame): SceneFit | null {
  const active = frame.traces[0]!;
  const isLoop = (points: readonly FitPoint[]) => {
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y),
      extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (
      distance(points[0]!, points.at(-1)!) > Math.max(0.03 * extent, 3 / (frame.size * frame.scale))
    )
      return false;
    const structure = curveStructure(
      points,
      0.25 / (frame.size * frame.scale),
      Math.min(0.03 * extent, noiseScale(resample(points, 192), true) * 6),
    );
    return structure !== null && structure.crossings.length === 0;
  };
  if (!isLoop(active.points)) return null;
  const contains = (a: readonly FitPoint[], b: readonly FitPoint[]) =>
    b.every((point) => polygonDistance(point, a) < -2 / (frame.size * frame.scale));
  const members = frame.traces.filter(
    (trace) =>
      trace.index === 0 ||
      (isLoop(trace.points) &&
        (contains(active.points, trace.points) || contains(trace.points, active.points))),
  );
  if (members.length < 2) return null;
  const paths = new Map<number, FitPoint[]>();
  let label: SceneFit["label"] = "polygon",
    parameters = 0;
  const world = (p: FitPoint) => ({
    x: frame.cx + p.x * frame.size,
    y: frame.cy + p.y * frame.size,
    pressure: 0.5,
  });
  for (const member of members) {
    const fit = repairShape(member.points.map(world), frame.scale, member.observations.map(world));
    if (!fit) return null;
    const points = fit.points.map((p) => ({
      x: (p.x - frame.cx) / frame.size,
      y: (p.y - frame.cy) / frame.size,
    }));
    if (!isLoop(points)) return null;
    paths.set(member.index, points);
    if (member.index === 0) label = fit.label;
    parameters += points.length * 2;
  }
  return { label, paths, parameters };
}
