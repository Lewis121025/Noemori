import { inkBounds } from "./geometry";
import type { InkPoint, InkStroke } from "./model";
import {
  REPAIR_CONTEXT_LIMIT,
  REPAIR_TOTAL_POINT_LIMIT,
  RECOGNITION_POINT_LIMIT,
  type RepairContext,
} from "./recognition";

/**
 * 获取最近邻近笔迹；这里只缩小计算范围，实际联动必须由几何与拓扑证明。
 * @param points 当前完整静态轨迹。
 * @param observations 当前全部原观测，用于总量计数。
 * @param strokes 按提交顺序的不可变笔迹。
 * @param scale 当前有限正缩放。
 * @returns 不截断任一笔画的有界上下文；超长笔画整体不参与联动。
 */
export function repairContext(
  points: readonly InkPoint[],
  observations: readonly InkPoint[],
  strokes: readonly InkStroke[],
  scale: number,
): RepairContext[] {
  const bounds = inkBounds([{ id: "active", width: 2, points }]);
  if (!bounds) return [];
  const recent = strokes.slice(-REPAIR_CONTEXT_LIMIT);
  const margin = Math.max(12 / scale, Math.max(bounds.width, bounds.height) * 0.5),
    result: RepairContext[] = [];
  let count = points.length + observations.length;
  const active = [points[0]!, points.at(-1)!],
    linked = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const stroke of recent) {
      if (linked.has(stroke.id)) continue;
      const source = stroke.source ?? stroke.points,
        ends = [source[0]!, source.at(-1)!],
        tolerance = Math.max(
          5 / scale,
          Math.hypot(ends[1]!.x - ends[0]!.x, ends[1]!.y - ends[0]!.y) * 0.12,
        );
      if (
        ends.some((end) => active.some((p) => Math.hypot(end.x - p.x, end.y - p.y) <= tolerance))
      ) {
        linked.add(stroke.id);
        active.push(...ends);
        grew = true;
      }
    }
  }
  for (const stroke of recent.reverse()) {
    const source = stroke.source ?? stroke.points,
      other = inkBounds([stroke]);
    if (
      !other ||
      stroke.points.length < 2 ||
      stroke.points.length > RECOGNITION_POINT_LIMIT ||
      source.length < 2 ||
      source.length > RECOGNITION_POINT_LIMIT ||
      count + stroke.points.length + source.length > REPAIR_TOTAL_POINT_LIMIT
    )
      continue;
    if (
      !linked.has(stroke.id) &&
      (other.x > bounds.x + bounds.width + margin ||
        other.x + other.width < bounds.x - margin ||
        other.y > bounds.y + bounds.height + margin ||
        other.y + other.height < bounds.y - margin)
    )
      continue;
    result.push({ id: stroke.id, points: stroke.points, observations: source });
    count += stroke.points.length + source.length;
  }
  return result.reverse();
}
