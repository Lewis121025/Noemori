import { fitArrowShaft, type ArrowShaft } from "./fitting-arrow-shaft";
import { curveCornerIndices } from "./fitting-corners";
import { strokeGraph, type GraphTrace, type StrokeGraph } from "./fitting-scene-graph";
import { distance, resample, contourDeviation, type FitPoint } from "./fitting-math";
import type { SceneFit } from "./fitting-scene";

/** 分段仅构建分支图，原笔画顺序与全部观测留在外层事务验收。 */
type Section = { trace: GraphTrace; owner: number; order: number };
/** 图边身份不因重描改变，别名在最终笔画组装时恢复。 */
type ArrowEdge = StrokeGraph["edges"][number];
/** 树上的有向主干路线，与原笔画方向独立。 */
type ArrowRoute = Array<{ edge: ArrowEdge; from: number; to: number }>;
/** 验证完成的分支树，只有一或两个三价箭尖。 */
type ArrowTree = {
  graph: StrokeGraph;
  unique: ArrowEdge[];
  adjacency: Map<number, ArrowEdge[]>;
  hubs: number[];
  leaves: number[];
};
const sameEdge = (a: ArrowEdge, b: ArrowEdge) =>
  (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);
const otherEnd = (edge: ArrowEdge, node: number) => (edge.from === node ? edge.to : edge.from);

function sections(traces: readonly GraphTrace[]): Section[] {
  const result: Section[] = [];
  for (const trace of traces) {
    const points = resample(trace.points, 192),
      indices = new Set(curveCornerIndices(points, false));
    // 箭翼末端可能原路返回，180度的折返也是图的叶节点，不是可忽略的平滑转向。
    const reversals = points.flatMap((point, i) => {
      if (i < 6 || i >= points.length - 6) return [];
      const a = points[i - 6]!,
        b = points[i + 6]!,
        first = Math.atan2(point.y - a.y, point.x - a.x),
        second = Math.atan2(b.y - point.y, b.x - point.x);
      return Math.abs(Math.atan2(Math.sin(second - first), Math.cos(second - first))) > 2.8
        ? [i]
        : [];
    });
    for (const i of reversals) if (![...indices].some((j) => Math.abs(j - i) < 10)) indices.add(i);
    const cuts = [0, ...[...indices].sort((a, b) => a - b), points.length - 1];
    for (let order = 0; order < cuts.length - 1; order++) {
      const part = points.slice(cuts[order]!, cuts[order + 1]! + 1);
      if (part.length < 2) continue;
      result.push({
        trace: { index: result.length, points: part, observations: part },
        owner: trace.index,
        order,
      });
    }
  }
  return result;
}

function branchTree(
  parts: readonly Section[],
  active: number,
  uncertainty: number,
): ArrowTree | null {
  const activePart = parts.find((part) => part.owner === active);
  if (!activePart) return null;
  const graph = strokeGraph(
      parts.map((part) => part.trace),
      activePart.trace.index,
      Math.max(0.001, (uncertainty * 5) / 3),
    ),
    unique: typeof graph.edges = [];
  for (const edge of graph.edges) {
    const same = unique.find(
      (other) =>
        (other.from === edge.from && other.to === edge.to) ||
        (other.from === edge.to && other.to === edge.from),
    );
    if (!same) {
      unique.push(edge);
      continue;
    }
    const error = contourDeviation(edge.trace.points, same.trace.points);
    if (!error || error.maximum > 0.04) return null;
  }
  const adjacency = new Map<number, typeof unique>();
  for (const edge of unique)
    for (const node of [edge.from, edge.to])
      adjacency.set(node, [...(adjacency.get(node) ?? []), edge]);
  const hubs = [...adjacency].filter(([, edges]) => edges.length === 3).map(([node]) => node),
    leaves = [...adjacency].filter(([, edges]) => edges.length === 1).map(([node]) => node);
  if (
    (hubs.length !== 1 && hubs.length !== 2) ||
    leaves.length !== hubs.length + 2 ||
    unique.length !== adjacency.size - 1 ||
    [...adjacency.values()].some((edges) => edges.length > 3)
  )
    return null;
  return { graph, unique, adjacency, hubs, leaves };
}
function route(adjacency: Map<number, ArrowEdge[]>, start: number, end: number): ArrowRoute | null {
  const search = (at: number, previous: number): ArrowRoute | null => {
    if (at === end) return [];
    for (const edge of adjacency.get(at) ?? []) {
      const next = otherEnd(edge, at);
      if (next === previous) continue;
      const rest = search(next, at);
      if (rest) return [{ edge, from: at, to: next }, ...rest];
    }
    return null;
  };
  return search(start, -1);
}
function chooseShaft(
  tree: ArrowTree,
): { start: number; shaft: ArrowRoute; shaftLength: number } | null {
  const { hubs, leaves, graph, adjacency } = tree;
  const start = hubs[0]!,
    end =
      hubs.length === 2
        ? hubs[1]!
        : leaves.reduce((best, node) => {
            const length = (node: number) =>
              route(adjacency, start, node)?.reduce(
                (sum, p) => sum + distance(graph.nodes[p.from]!, graph.nodes[p.to]!),
                0,
              ) ?? 0;
            return length(node) > length(best) ? node : best;
          }, leaves[0]!);
  const shaft = route(adjacency, start, end);
  if (!shaft?.length) return null;
  const shaftLength = shaft.reduce(
    (sum, p) =>
      sum +
      p.edge.trace.points.slice(1).reduce((s, q, i) => s + distance(p.edge.trace.points[i]!, q), 0),
    0,
  );
  if (shaftLength < 0.4) return null;
  return { start, shaft, shaftLength };
}
function fitHeads(
  tree: ArrowTree,
  shaft: ArrowRoute,
  start: number,
  shaftLength: number,
  shaftGeometry: Map<ArrowEdge, ArrowShaft>,
  fittedEdges: Map<ArrowEdge, FitPoint[]>,
): boolean {
  const { hubs, graph, adjacency } = tree;
  for (const hub of hubs) {
    const stem = hub === start ? shaft[0]! : shaft.at(-1)!,
      geometry = shaftGeometry.get(stem.edge)!,
      tip = graph.nodes[hub]!,
      d = stem.edge.from === hub ? geometry.from : geometry.to;
    const wings = (adjacency.get(hub) ?? []).filter((edge) => edge !== stem.edge);
    if (
      wings.length !== 2 ||
      wings.some((edge) => (adjacency.get(otherEnd(edge, hub))?.length ?? 0) !== 1)
    )
      return false;
    const ends = wings.map((edge) => graph.nodes[otherEnd(edge, hub)]!),
      local = ends.map((p) => ({
        x: (p.x - tip.x) * d.x + (p.y - tip.y) * d.y,
        y: -(p.x - tip.x) * d.y + (p.y - tip.y) * d.x,
      }));
    if (local[0]!.y * local[1]!.y >= 0 || local.some((p) => p.x > -0.02)) return false;
    const back = -(local[0]!.x + local[1]!.x) / 2,
      width = (Math.abs(local[0]!.y) + Math.abs(local[1]!.y)) / 2;
    if (back < 0.025 || back > shaftLength * 0.4 || width < 0.02 || width > shaftLength * 0.35)
      return false;
    for (const [i, edge] of wings.entries()) {
      const side = Math.sign(local[i]!.y),
        end = {
          x: tip.x - back * d.x - side * width * d.y,
          y: tip.y - back * d.y + side * width * d.x,
        };
      fittedEdges.set(edge, edge.from === hub ? [tip, end] : [end, tip]);
    }
  }
  return true;
}
function assemblePaths(
  tree: ArrowTree,
  parts: readonly Section[],
  traces: readonly GraphTrace[],
  fittedEdges: Map<ArrowEdge, FitPoint[]>,
): Map<number, FitPoint[]> | null {
  const { graph, unique } = tree;
  const byOwner = new Map<number, Array<{ order: number; points: FitPoint[] }>>();
  for (const edge of graph.edges) {
    const match = unique.find((other) => sameEdge(other, edge)),
      fitted = match ? fittedEdges.get(match) : null;
    if (!fitted) return null;
    const part = parts[edge.trace.index]!,
      points = edge.from === match!.from ? fitted : [...fitted].reverse();
    byOwner.set(part.owner, [...(byOwner.get(part.owner) ?? []), { order: part.order, points }]);
  }
  const paths = new Map<number, FitPoint[]>();
  for (const [owner, parts] of byOwner) {
    parts.sort((a, b) => a.order - b.order);
    if (parts.length !== sections([traces.find((t) => t.index === owner)!]).length) return null;
    paths.set(
      owner,
      parts.flatMap((part, i) => (i === 0 ? part.points : part.points.slice(1))),
    );
  }
  return paths;
}

/**
 * 从三价分支树拟合单/双箭头，主干可为折线或保形样条；头部方向取主干端点切线。
 * @param traces 共享归一化的完整笔画。
 * @param active 当前停笔的原身份索引。
 * @param uncertainty 归一化定位预算。
 * @returns 维持原笔画方向和必要回程的候选；缺翼、额外分支或歧义结构返回null。
 * @throws 数值错误传播，调用方仍须逐笔全观测验收。
 */
export function fitBranchedArrows(
  traces: readonly GraphTrace[],
  active: number,
  uncertainty: number,
): SceneFit | null {
  const parts = sections(traces),
    tree = branchTree(parts, active, uncertainty);
  if (!tree) return null;
  const selected = chooseShaft(tree);
  if (!selected) return null;
  const { start, shaft, shaftLength } = selected,
    { graph, hubs } = tree;
  const fittedEdges = new Map<ArrowEdge, FitPoint[]>();
  const shaftGeometry = new Map<ArrowEdge, ArrowShaft>();
  for (const part of shaft) {
    const geometry = fitArrowShaft(part.edge.trace, uncertainty);
    if (!geometry) return null;
    geometry.points[0] = graph.nodes[part.edge.from]!;
    geometry.points[geometry.points.length - 1] = graph.nodes[part.edge.to]!;
    fittedEdges.set(part.edge, geometry.points);
    shaftGeometry.set(part.edge, geometry);
  }
  if (!fitHeads(tree, shaft, start, shaftLength, shaftGeometry, fittedEdges)) return null;
  const paths = assemblePaths(tree, parts, traces, fittedEdges);
  return paths?.has(active) ? { label: "arrow", paths, parameters: 8 + hubs.length * 2 } : null;
}
