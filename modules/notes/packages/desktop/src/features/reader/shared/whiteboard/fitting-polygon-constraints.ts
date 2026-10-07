import { refinePolyline } from "./fitting-lines";
import {
  distance,
  leastSquares,
  perimeterAdvance,
  segmentDistance,
  type FitPoint,
} from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";

/** 约束直接由参数化满足，输出仍使用既有规范轮廓，不保存不可验证的约束标志。 */
export type ConstrainedPolygonFit = {
  label: "rectangle" | "triangle" | "polygon" | "star";
  points: FitPoint[];
  parameters: number;
};
/** 有限几何族共享同一数据目标与求解器，构造器不得删改观测或独立移动某个顶点。 */
type PolygonFamily = {
  label: ConstrainedPolygonFit["label"];
  initial: number[];
  contour: (parameters: readonly number[]) => FitPoint[];
};

function center(points: readonly FitPoint[]): FitPoint {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

function winding(points: readonly FitPoint[]): number {
  return Math.sign(
    points.reduce((sum, p, i) => {
      const next = points[(i + 1) % points.length]!;
      return sum + p.x * next.y - p.y * next.x;
    }, 0),
  );
}

function positioned(x: number, y: number, origin: FitPoint, angle: number): FitPoint {
  return {
    x: origin.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: origin.y + x * Math.sin(angle) + y * Math.cos(angle),
  };
}

/** 正多边形与交替半径星形共用极坐标参数；少一个自由度意味着真实等边或对称约束。 */
function radialFamily(vertices: readonly FitPoint[], star = false): PolygonFamily {
  const origin = center(vertices),
    count = vertices.length,
    sign = winding(vertices);
  const radii = vertices.map((point) => distance(point, origin));
  const parity =
    star &&
    radii.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) <
      radii.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0)
      ? 1
      : 0;
  const outer = star ? radii.filter((_, i) => i % 2 === parity) : radii;
  const radius = outer.reduce((a, b) => a + b, 0) / outer.length;
  const inner = star ? radii.filter((_, i) => i % 2 !== parity) : [];
  const ratio = star ? inner.reduce((a, b) => a + b, 0) / inner.length / radius : 1;
  const angle = Math.atan2(vertices[0]!.y - origin.y, vertices[0]!.x - origin.x);
  const initial = [origin.x, origin.y, Math.log(radius), angle];
  if (star) initial.push(Math.log(ratio));
  return {
    label: star ? "star" : count === 3 ? "triangle" : count === 4 ? "rectangle" : "polygon",
    initial,
    contour: (p) =>
      vertices.map((_, i) => {
        const angle = p[3]! + (sign * i * 2 * Math.PI) / count;
        const radius = Math.exp(p[2]!) * (star && i % 2 !== parity ? Math.exp(p[4]!) : 1);
        return { x: p[0]! + radius * Math.cos(angle), y: p[1]! + radius * Math.sin(angle) };
      }),
  };
}

function triangleFamilies(vertices: readonly FitPoint[]): PolygonFamily[] {
  const sign = winding(vertices),
    result: PolygonFamily[] = [];
  for (let at = 0; at < 3; at++) {
    const a = vertices[at]!,
      b = vertices[(at + 1) % 3]!,
      c = vertices[(at + 2) % 3]!;
    const middle = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 },
      base = distance(b, c) / 2,
      angle = Math.atan2(c.y - b.y, c.x - b.x),
      height = (a.x - middle.x) * Math.sin(angle) - (a.y - middle.y) * Math.cos(angle);
    result.push({
      label: "triangle",
      initial: [middle.x, middle.y, Math.log(base), Math.log(Math.abs(height)), angle],
      contour: (p) => {
        const origin = { x: p[0]!, y: p[1]! },
          w = Math.exp(p[2]!),
          h = Math.exp(p[3]!) * Math.sign(height);
        const points = [
          positioned(0, -h, origin, p[4]!),
          positioned(-w, 0, origin, p[4]!),
          positioned(w, 0, origin, p[4]!),
        ];
        return vertices.map((_, i) => points[(i - at + 3) % 3]!);
      },
    });
    const direction = Math.atan2(b.y - a.y, b.x - a.x);
    result.push({
      label: "triangle",
      initial: [a.x, a.y, Math.log(distance(a, b)), Math.log(distance(a, c)), direction],
      contour: (p) => {
        const origin = { x: p[0]!, y: p[1]! };
        const points = [
          origin,
          positioned(Math.exp(p[2]!), 0, origin, p[4]!),
          positioned(0, sign * Math.exp(p[3]!), origin, p[4]!),
        ];
        return vertices.map((_, i) => points[(i - at + 3) % 3]!);
      },
    });
  }
  return result;
}

function quadrilateralFamilies(vertices: readonly FitPoint[]): PolygonFamily[] {
  const [a, b, c, d] = vertices;
  if (!a || !b || !c || !d) return [];
  const origin = center(vertices),
    u = { x: (b.x + c.x - a.x - d.x) / 4, y: (b.y + c.y - a.y - d.y) / 4 },
    v = { x: (c.x + d.x - a.x - b.x) / 4, y: (c.y + d.y - a.y - b.y) / 4 };
  const parallelogram: PolygonFamily = {
    label: "polygon",
    initial: [origin.x, origin.y, u.x, u.y, v.x, v.y],
    contour: (p) =>
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([sx, sy]) => ({
        x: p[0]! + sx! * p[2]! + sy! * p[4]!,
        y: p[1]! + sx! * p[3]! + sy! * p[5]!,
      })),
  };
  const first = distance(a, c) / 2,
    second = distance(b, d) / 2,
    angle = Math.atan2(a.y - c.y, a.x - c.x),
    sign = winding(vertices);
  const rhombus: PolygonFamily = {
    label: "polygon",
    initial: [origin.x, origin.y, Math.log(first), Math.log(second), angle],
    contour: (p) =>
      [
        [Math.exp(p[2]!), 0],
        [0, sign * Math.exp(p[3]!)],
        [-Math.exp(p[2]!), 0],
        [0, -sign * Math.exp(p[3]!)],
      ].map(([x, y]) => positioned(x!, y!, { x: p[0]!, y: p[1]! }, p[4]!)),
  };
  const trapezoids: PolygonFamily[] = [];
  for (let offset = 0; offset < 2; offset++) {
    const points = vertices.map((_, i) => vertices[(i + offset) % 4]!);
    const [a, b, c, d] = points;
    if (!a || !b || !c || !d) continue;
    const angle = Math.atan2(b.y - a.y, b.x - a.x),
      top = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      bottom = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
    const height =
        (-(bottom.x - top.x) * Math.sin(angle) + (bottom.y - top.y) * Math.cos(angle)) / 2,
      shift = (top.x - bottom.x) * Math.cos(angle) + (top.y - bottom.y) * Math.sin(angle);
    const origin = {
      x: bottom.x + height * Math.sin(angle),
      y: bottom.y - height * Math.cos(angle),
    };
    trapezoids.push({
      label: "polygon",
      initial: [
        origin.x,
        origin.y,
        Math.log(Math.abs(height)),
        Math.log(distance(a, b) / 2),
        Math.log(distance(c, d) / 2),
        shift,
        angle,
      ],
      contour: (p) => {
        const h = Math.exp(p[2]!) * Math.sign(height),
          top = Math.exp(p[3]!),
          bottom = Math.exp(p[4]!);
        const local = [
          [p[5]! - top, -h],
          [p[5]! + top, -h],
          [bottom, h],
          [-bottom, h],
        ].map(([x, y]) => positioned(x!, y!, { x: p[0]!, y: p[1]! }, p[6]!));
        return vertices.map((_, i) => local[(i - offset + 4) % 4]!);
      },
    });
  }
  return [parallelogram, rhombus, ...trapezoids];
}

/** 星形允许仿射比例变化；内外顶点仍共享一套半径比，不逐个追随尖角噪声。 */
function affineStar(vertices: readonly FitPoint[]): PolygonFamily | null {
  if (vertices.length < 6 || vertices.length % 2 !== 0) return null;
  const radial = radialFamily(vertices, true),
    ratio = Math.exp(radial.initial[4]!);
  if (!(ratio > 0.1 && ratio < 0.8)) return null;
  const first = radial.contour(radial.initial),
    origin = center(vertices),
    weights = first.map((p) => [1, p.x - origin.x, p.y - origin.y]);
  const parity =
    vertices.filter((_, i) => i % 2 === 0).reduce((sum, p) => sum + distance(p, origin), 0) >=
    vertices.filter((_, i) => i % 2 === 1).reduce((sum, p) => sum + distance(p, origin), 0)
      ? 0
      : 1;
  const x = leastSquares(
      weights,
      vertices.map((p) => p.x),
    ),
    y = leastSquares(
      weights,
      vertices.map((p) => p.y),
    );
  if (!x || !y) return null;
  return {
    label: "star",
    initial: [x[0]!, y[0]!, x[1]!, x[2]!, y[1]!, y[2]!, Math.log(ratio)],
    contour: (p) =>
      first.map((point, i) => {
        const factor = i % 2 === parity ? 1 : Math.exp(p[6]!) / ratio;
        const x = (point.x - origin.x) * factor,
          y = (point.y - origin.y) * factor;
        return { x: p[0]! + x * p[2]! + y * p[3]!, y: p[1]! + x * p[4]! + y * p[5]! };
      }),
  };
}

function closedContour(family: PolygonFamily, parameters: readonly number[]): FitPoint[] | null {
  if (!parameters.every(Number.isFinite)) return null;
  const points = family.contour(parameters);
  if (
    points.some(
      (p) =>
        !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 3 || Math.abs(p.y) > 3,
    ) ||
    points.some((p, i) => distance(p, points[(i + 1) % points.length]!) < 0.025)
  )
    return null;
  return [...points, points[0]!];
}

/**
 * 拟合正多边形、特殊三角形、平行四边形、菱形、梯形及外轮廓星形的精确几何约束。
 * @param sampled 完整等弧长有限归一化采样，至少192点；用于统计目标。
 * @param corners 已验证的闭合角点轮廓，首尾相同；结构身份由调用方另行验收。
 * @param uncertainty 归一化位置不确定性，构造初值必须有观测支持。
 * @param observations 完整原始观测，仅参与最大偏差约束，不按停笔密度加权。
 * @param trace 保留真实顺序及有界回描的静态轨迹，用于完整绕行和重描验收。
 * @returns 在同一Huber目标下联合优化的候选；退化或不受角点支持的族不产生结果。
 * @throws 数值求解错误向上传播，不删点或伪造已成立的约束。
 */
export function fitPolygonConstraints(
  sampled: readonly FitPoint[],
  corners: readonly FitPoint[],
  uncertainty: number,
  observations: readonly FitPoint[] = sampled,
  trace: readonly FitPoint[] = sampled,
): ConstrainedPolygonFit[] {
  if (corners.length < 4 || distance(corners[0]!, corners.at(-1)!) > 1e-8) return [];
  const advance = perimeterAdvance(trace, corners);
  if (advance === null || Math.abs(Math.abs(advance) - 1) > 0.4 / (2 * Math.PI)) return [];
  const witness = refinePolyline(sampled, corners, uncertainty);
  if (!witness) return [];
  const vertices = witness.slice(0, -1),
    families: PolygonFamily[] = [radialFamily(vertices)];
  if (vertices.length === 3) families.push(...triangleFamilies(vertices));
  if (vertices.length === 4) families.push(...quadrilateralFamilies(vertices));
  const alternating =
    vertices.length >= 6 &&
    vertices.length % 2 === 0 &&
    vertices.every((point, i) => {
      const before = vertices[(i + vertices.length - 1) % vertices.length]!,
        after = vertices[(i + 1) % vertices.length]!;
      const turn =
        (point.x - before.x) * (after.y - point.y) - (point.y - before.y) * (after.x - point.x);
      const next = vertices[(i + 2) % vertices.length]!,
        nextTurn =
          (after.x - point.x) * (next.y - after.y) - (after.y - point.y) * (next.x - after.x);
      return turn * nextTurn < 0;
    });
  if (alternating) {
    families.push(radialFamily(vertices, true));
    const affine = affineStar(vertices);
    if (affine) families.push(affine);
  }
  const evidence = Math.max(uncertainty * 3, 0.025),
    data = [...sampled, ...observations],
    result: ConstrainedPolygonFit[] = [];
  for (const family of families) {
    const initial = closedContour(family, family.initial);
    if (!initial || vertices.some((point, i) => distance(point, initial[i]!) > evidence)) continue;
    const residuals = (p: readonly number[]) => {
      const contour = closedContour(family, p);
      return contour
        ? data.map((point) =>
            Math.min(...contour.slice(1).map((end, i) => segmentDistance(point, contour[i]!, end))),
          )
        : null;
    };
    const parameters = optimizeGeometry(
        family.initial,
        residuals,
        uncertainty,
        0.12,
        undefined,
        undefined,
        sampled.length,
      ),
      points = parameters ? closedContour(family, parameters) : null;
    const traversal = points ? perimeterAdvance(trace, points) : null;
    if (
      points &&
      points.slice(0, -1).every((point, i) => distance(point, vertices[i]!) <= evidence) &&
      traversal !== null &&
      Math.abs(Math.abs(traversal) - 1) <= 0.4 / (2 * Math.PI) &&
      winding(points.slice(0, -1)) === winding(vertices)
    )
      result.push({ label: family.label, points, parameters: family.initial.length });
  }
  return result;
}
