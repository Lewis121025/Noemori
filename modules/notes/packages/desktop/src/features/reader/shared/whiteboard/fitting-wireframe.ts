import { strokeGraph, type StrokeGraph } from "./fitting-scene-graph";
import { distance, leastSquares, resample, segmentDistance, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";
import type { SceneFit, SceneFrame } from "./fitting-scene";
import type { ScenePrimitive } from "./fitting-primitives";

/** Cube图的八个顶点以三个二元坐标标记，拓扑匹配与空间方向无关。 */
function cubeCoordinates(graph: StrokeGraph): Map<number, number[]> | null {
  const adjacency = new Map<number, Set<number>>();
  for (const edge of graph.edges) {
    if (adjacency.get(edge.from)?.has(edge.to)) return null;
    for (const [a, b] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ]) {
      const neighbors = adjacency.get(a!) ?? new Set<number>();
      neighbors.add(b!);
      adjacency.set(a!, neighbors);
    }
  }
  if (
    adjacency.size !== 8 ||
    graph.edges.length !== 12 ||
    [...adjacency.values()].some((n) => n.size !== 3)
  )
    return null;
  const first = graph.edges[0]!.from,
    neighbors = [...adjacency.get(first)!],
    codes = new Map<number, number>([
      [first, 0],
      ...neighbors.map((n, i): [number, number] => [n, 1 << i]),
    ]);
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const common = [...adjacency.get(neighbors[i]!)!].filter(
        (n) => n !== first && adjacency.get(neighbors[j]!)!.has(n),
      );
      if (common.length !== 1 || codes.has(common[0]!)) return null;
      codes.set(common[0]!, (1 << i) | (1 << j));
    }
  const last = [...adjacency.keys()].filter((n) => !codes.has(n));
  if (last.length !== 1) return null;
  codes.set(last[0]!, 7);
  for (const edge of graph.edges) {
    const xor = codes.get(edge.from)! ^ codes.get(edge.to)!;
    if (xor !== 1 && xor !== 2 && xor !== 4) return null;
  }
  return new Map(
    [...codes].map(([node, code]) => [node, [1, code & 1, (code >> 1) & 1, (code >> 2) & 1]]),
  );
}

/**
 * 验证Cube图后联合拟合仿射或透视投影；这是二维线框修复，不推断标定的三维尺寸。
 * @param frame 同一归一化场景及完整观测。
 * @param primitives 验收通过的直线基元，十二条边必须形成八个三价接点。
 * @returns 共用八顶点的长方体/立方体线框候选；缺边、额外边、歧义接点返回空数组。
 * @throws 数值错误传播，最终仍需逐笔全观测验收。
 */
export function fitWireframe(frame: SceneFrame, primitives: readonly ScenePrimitive[]): SceneFit[] {
  const graph = strokeGraph(
      primitives.filter((p) => p.kind === "line").map((p) => p.trace),
      0,
      5 / (frame.size * frame.scale),
    ),
    codes = cubeCoordinates(graph);
  if (!codes) return [];
  const rows = [...codes.values()],
    nodes = [...codes.keys()],
    x = leastSquares(
      rows,
      nodes.map((n) => graph.nodes[n]!.x),
    ),
    y = leastSquares(
      rows,
      nodes.map((n) => graph.nodes[n]!.y),
    );
  if (!x || !y) return [];
  const starts: Array<{ p: number[]; perspective: boolean }> = [
    { p: [...x, ...y], perspective: false },
  ];
  const design: number[][] = [],
    target: number[] = [];
  for (const node of nodes) {
    const row = codes.get(node)!,
      point = graph.nodes[node]!;
    design.push(
      [...row, 0, 0, 0, 0, ...row.slice(1).map((v) => -point.x * v)],
      [0, 0, 0, 0, ...row, ...row.slice(1).map((v) => -point.y * v)],
    );
    target.push(point.x, point.y);
  }
  const projective = leastSquares(design, target);
  if (projective) starts.push({ p: projective, perspective: true });
  const sampled = graph.edges.flatMap((edge) =>
      resample(edge.trace.points, 24).map((point) => ({ edge, point })),
    ),
    observed = graph.edges.flatMap((edge) =>
      edge.trace.observations.map((point) => ({ edge, point })),
    ),
    data = [...sampled, ...observed],
    result: SceneFit[] = [];
  for (const start of starts) {
    const geometry = (p: readonly number[]): Map<number, FitPoint> | null => {
      if (!p.every(Number.isFinite)) return null;
      const positions = new Map<number, FitPoint>();
      for (const [node, row] of codes) {
        const divisor = start.perspective
          ? 1 + row.slice(1).reduce((sum, v, i) => sum + v * p[8 + i]!, 0)
          : 1;
        if (divisor < 0.2 || divisor > 4) return null;
        positions.set(node, {
          x: row.reduce((sum, v, i) => sum + v * p[i]!, 0) / divisor,
          y: row.reduce((sum, v, i) => sum + v * p[4 + i]!, 0) / divisor,
        });
      }
      if (
        graph.edges.some(
          (edge) => distance(positions.get(edge.from)!, positions.get(edge.to)!) < 0.04,
        )
      )
        return null;
      return positions;
    };
    const fit = optimizeGeometry(
        start.p,
        (p) => {
          const g = geometry(p);
          return g
            ? data.map(({ edge, point }) =>
                segmentDistance(point, g.get(edge.from)!, g.get(edge.to)!),
              )
            : null;
        },
        Math.min(0.01, 3 / (frame.size * frame.scale)),
        0.04,
        undefined,
        undefined,
        sampled.length,
      ),
      g = fit ? geometry(fit) : null;
    if (!g) continue;
    result.push({
      label: "wireframe",
      parameters: start.p.length,
      paths: new Map(
        graph.edges.map((edge) => [edge.trace.index, [g.get(edge.from)!, g.get(edge.to)!]]),
      ),
    });
  }
  return result;
}
