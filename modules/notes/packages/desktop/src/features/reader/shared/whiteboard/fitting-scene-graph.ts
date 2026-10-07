import { distance, type FitPoint } from "./fitting-math";

/** 一笔是一条带顺序的图边，抬笔不制造虚构连线。 */
export type GraphTrace = {
  readonly index: number;
  readonly points: readonly FitPoint[];
  readonly observations: readonly FitPoint[];
};
/** 节点共享后，所有连接约束直接引用同一位置。 */
export type StrokeGraph = {
  nodes: FitPoint[];
  edges: Array<{ trace: GraphTrace; from: number; to: number }>;
};
/** 沿图边遍历时记录方向，输出必须还原每笔原来的方向和身份。 */
export type GraphVisit = { edge: StrokeGraph["edges"][number]; reversed: boolean };

/**
 * 按有界端点连接构建活动笔迹的连通分量，不按包围盒或书写先后拼接。
 * @param traces 同一归一化坐标系的开放静态轨迹和完整观测。
 * @param active 当前停笔身份索引。
 * @param tolerance 屏幕定位误差换算的归一化下限，几何预算再按每笔尺寸计算。
 * @returns 节点与边；相近的闭合独立轮廓不混入端点图。
 */
export function strokeGraph(
  traces: readonly GraphTrace[],
  active: number,
  tolerance: number,
): StrokeGraph {
  const nodes: FitPoint[] = [],
    clusters: Array<{ points: FitPoint[]; radius: number }> = [],
    edges: StrokeGraph["edges"] = [];
  const node = (point: FitPoint, radius: number) => {
    const candidates = clusters.flatMap((cluster, i) =>
      cluster.points.every((p) => distance(p, point) <= Math.min(radius, cluster.radius))
        ? [i]
        : [],
    );
    if (candidates.length > 1) return -1;
    if (candidates.length === 1) {
      const i = candidates[0]!;
      clusters[i]!.points.push(point);
      clusters[i]!.radius = Math.min(clusters[i]!.radius, radius);
      nodes[i] = {
        x: clusters[i]!.points.reduce((s, p) => s + p.x, 0) / clusters[i]!.points.length,
        y: clusters[i]!.points.reduce((s, p) => s + p.y, 0) / clusters[i]!.points.length,
      };
      return i;
    }
    clusters.push({ points: [point], radius });
    nodes.push(point);
    return nodes.length - 1;
  };
  for (const trace of traces) {
    if (trace.points.length < 2) continue;
    const xs = trace.points.map((p) => p.x),
      ys = trace.points.map((p) => p.y),
      extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
      radius = Math.max(tolerance, 0.12 * extent);
    if (distance(trace.points[0]!, trace.points.at(-1)!) <= radius) continue;
    const from = node(trace.observations[0]!, radius),
      to = node(trace.observations.at(-1)!, radius);
    if (from >= 0 && to >= 0 && from !== to) edges.push({ trace, from, to });
  }
  const start = edges.find((e) => e.trace.index === active);
  if (!start) return { nodes: [], edges: [] };
  const connected = new Set([start.from, start.to]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges)
      if (connected.has(edge.from) || connected.has(edge.to)) {
        if (!connected.has(edge.from) || !connected.has(edge.to)) changed = true;
        connected.add(edge.from);
        connected.add(edge.to);
      }
  }
  return {
    nodes,
    edges: edges.filter((edge) => connected.has(edge.from) && connected.has(edge.to)),
  };
}

/**
 * 无分支路径或单圈可唯一遍历；分支图留给箭头、线框等具备相应拓扑的几何族。
 * @param graph 活动笔迹的端点连通分量。
 * @returns 顺序与反向标记；多重边、未完成遍历或分支返回null。
 */
export function graphWalk(graph: StrokeGraph): GraphVisit[] | null {
  if (graph.edges.length < 2) return null;
  const adjacency = new Map<number, StrokeGraph["edges"]>();
  for (const edge of graph.edges)
    for (const at of [edge.from, edge.to]) adjacency.set(at, [...(adjacency.get(at) ?? []), edge]);
  const ends = [...adjacency].filter(([, edges]) => edges.length === 1);
  if (
    [...adjacency.values()].some((edges) => edges.length > 2) ||
    !(ends.length === 0 || ends.length === 2)
  )
    return null;
  let at = ends[0]?.[0] ?? graph.edges[0]!.from;
  const used = new Set<StrokeGraph["edges"][number]>(),
    result: GraphVisit[] = [];
  while (used.size < graph.edges.length) {
    const edge = adjacency.get(at)?.find((edge) => !used.has(edge));
    if (!edge) return null;
    used.add(edge);
    const reversed = edge.to === at;
    result.push({ edge, reversed });
    at = reversed ? edge.from : edge.to;
  }
  return result;
}

/**
 * 将规范单圈切回原笔画区间；共用几何接点保证没有修复后新出现的裂缝。
 * @param contour 按图遍历方向的规范点列。
 * @param visits 图遍历及原身份。
 * @returns 每笔规范点列；退化输出返回null。
 */
export function splitGraphContour(
  contour: readonly FitPoint[],
  visits: readonly GraphVisit[],
  nodes: readonly FitPoint[],
): Map<number, FitPoint[]> | null {
  const closed = distance(contour[0]!, contour.at(-1)!) < 1e-8;
  const lengths = [0];
  for (let i = 1; i < contour.length; i++)
    lengths.push(lengths.at(-1)! + distance(contour[i - 1]!, contour[i]!));
  const total = lengths.at(-1)!;
  if (total < 1e-8) return null;
  const closest = (p: FitPoint) => {
    let at = 0,
      error = Infinity;
    for (let i = 1; i < contour.length; i++) {
      const a = contour[i - 1]!,
        b = contour[i]!,
        length = lengths[i]! - lengths[i - 1]!;
      if (length < 1e-10) continue;
      const t = Math.max(
          0,
          Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length ** 2),
        ),
        d = distance(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      if (d < error) {
        error = d;
        at = lengths[i - 1]! + t * length;
      }
    }
    const vertex = contour.reduce(
      (best, q, i) => (distance(q, p) < distance(contour[best]!, p) ? i : best),
      0,
    );
    // 角点数与图接点一一对应时，接点绑定规范顶点；小缺口不能把一条直边切出新转角。
    return (closed && contour.length === visits.length + 1) || distance(contour[vertex]!, p) < 0.025
      ? lengths[vertex]!
      : at;
  };
  const pointAt = (position: number) => {
    const t = closed
      ? ((position % total) + total) % total
      : Math.max(0, Math.min(total, position));
    const i = Math.max(
      1,
      lengths.findIndex((value, index) => index > 0 && value >= t),
    );
    const a = contour[i - 1]!,
      b = contour[i]!,
      part = (t - lengths[i - 1]!) / (lengths[i]! - lengths[i - 1]! || 1);
    return { x: a.x + part * (b.x - a.x), y: a.y + part * (b.y - a.y) };
  };
  const joints = visits.map((v) => closest(nodes[v.reversed ? v.edge.to : v.edge.from]!));
  const first = joints[0]!;
  for (let i = 1; i < joints.length; i++) {
    if (closed) while (joints[i]! < joints[i - 1]! - 0.02 * total) joints[i] = joints[i]! + total;
    else if (joints[i]! < joints[i - 1]!) return null;
  }
  joints.push(closed ? first + total : total);
  const result = new Map<number, FitPoint[]>();
  for (let i = 0; i < visits.length; i++) {
    const start = joints[i]!,
      end = joints[i + 1]!;
    if (end - start < 1e-6) return null;
    const middle: FitPoint[] = [];
    for (
      let cycle = closed ? Math.floor(start / total) : 0;
      cycle <= (closed ? Math.floor(end / total) : 0);
      cycle++
    )
      for (let j = 1; j < contour.length; j++) {
        const at = lengths[j]! + cycle * total;
        if (at > start + 1e-8 && at < end - 1e-8) middle.push(contour[j]!);
      }
    const points = [pointAt(start), ...middle, pointAt(end)];
    if (visits[i]!.reversed) points.reverse();
    result.set(visits[i]!.edge.trace.index, points);
  }
  return result;
}
