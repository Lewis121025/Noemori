import { straightEvidence } from "./fitting-straight-evidence";
import { circleContour } from "./fitting-conics";
import { angleAdvance, distance, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";

/** 直边与圆弧共享中心、方向和半径；相切是参数化不变量，不以端点近似拼接。 */
export type RoundedContourFit = {
  label: "rounded-rectangle" | "capsule";
  points: FitPoint[];
  parameters: number;
};

/** 闭合圆角边界的统一参数；胶囊强制radius等于短半边长。 */
type RoundedGeometry = {
  center: FitPoint;
  width: number;
  height: number;
  radius: number;
  angle: number;
};

function geometry(parameters: readonly number[], capsule: boolean): RoundedGeometry | null {
  const radius = capsule ? Math.exp(parameters[3]!) : 0;
  const width = capsule ? radius + Math.exp(parameters[2]!) : Math.exp(parameters[2]!),
    height = capsule ? radius : Math.exp(parameters[3]!);
  const rounded = capsule ? radius : Math.min(width, height) / (1 + Math.exp(-parameters[5]!));
  if (
    ![width, height, rounded].every(Number.isFinite) ||
    Math.min(width, height) < 0.04 ||
    Math.max(width, height) > 2 ||
    rounded < 0.008
  )
    return null;
  return {
    center: { x: parameters[0]!, y: parameters[1]! },
    width,
    height,
    radius: rounded,
    angle: parameters[4]!,
  };
}

/** 精确圆角矩形SDF，内部、直边、圆角与胶囊端部采用同一真实轮廓距离。 */
function boundaryDistance(point: FitPoint, fit: RoundedGeometry): number {
  const x = point.x - fit.center.x,
    y = point.y - fit.center.y,
    u = Math.abs(x * Math.cos(fit.angle) + y * Math.sin(fit.angle)) - fit.width + fit.radius,
    v = Math.abs(-x * Math.sin(fit.angle) + y * Math.cos(fit.angle)) - fit.height + fit.radius;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0) - fit.radius;
}

function contour(fit: RoundedGeometry, trace: readonly FitPoint[]): FitPoint[] | null {
  const dx = Math.cos(fit.angle),
    dy = Math.sin(fit.angle),
    r = fit.radius,
    corners = [
      [fit.width - r, -fit.height + r, -Math.PI / 2],
      [fit.width - r, fit.height - r, 0],
      [-fit.width + r, fit.height - r, Math.PI / 2],
      [-fit.width + r, -fit.height + r, Math.PI],
    ];
  // 四个四分之一圆弧合计使用整圆128段预算，不能让每个圆角重复整圆分辨率。
  const local = corners.flatMap(([x, y, start]) =>
    circleContour({ center: { x: x!, y: y! }, radius: r }, start!, Math.PI / 2).filter(
      (_, i) => i % 4 === 0,
    ),
  );
  local.push(local[0]!);
  let points = local.map((point) => ({
    x: fit.center.x + point.x * dx - point.y * dy,
    y: fit.center.y + point.x * dy + point.y * dx,
  }));
  const sweep = angleAdvance(
    trace.map((point) => Math.atan2(point.y - fit.center.y, point.x - fit.center.x)),
  );
  if (sweep === null || Math.abs(Math.abs(sweep) - 2 * Math.PI) > 0.4) return null;
  if (sweep < 0) points = points.reverse();
  const at = points
    .slice(0, -1)
    .reduce(
      (best, point, i) =>
        distance(point, trace[0]!) < distance(points[best]!, trace[0]!) ? i : best,
      0,
    );
  return [...points.slice(at, -1), ...points.slice(0, at + 1)];
}

/** 圆角族的长直段必须有实测支持，连续曲率的椭圆不能只凭低残差变成胶囊。 */
function supportedSides(sampled: readonly FitPoint[], fit: RoundedGeometry): boolean {
  const w = fit.width,
    h = fit.height,
    r = fit.radius,
    c = Math.cos(fit.angle),
    s = Math.sin(fit.angle);
  const world = (x: number, y: number) => ({
    x: fit.center.x + x * c - y * s,
    y: fit.center.y + x * s + y * c,
  });
  const edges = [
    [
      [-w + r, -h],
      [w - r, -h],
    ],
    [
      [w, -h + r],
      [w, h - r],
    ],
    [
      [w - r, h],
      [-w + r, h],
    ],
    [
      [-w, h - r],
      [-w, -h + r],
    ],
  ]
    .map(([a, b]) => [world(a![0]!, a![1]!), world(b![0]!, b![1]!)])
    .filter((edge) => distance(edge[0]!, edge[1]!) > 0.065);
  return edges.length >= 2 && edges.every((edge) => straightEvidence(sampled, edge[0]!, edge[1]!));
}

/**
 * 精确距离目标联合拟合圆角矩形与胶囊；四个圆角半径一致，所有直弧连接严格相切。
 * @param sampled 等弧长有限归一化采样，用于Huber统计目标。
 * @param trace 保留顺序与有界回访的闭合轮廓，重复绕行必须拒绝。
 * @param observations 完整原始观测，仅约束最大偏差，不按停笔采样密度加权。
 * @param initial 五点闭合矩形初值，只提供方向和尺寸，不预先决定最终图形族。
 * @param uncertainty 归一化的位置不确定性。
 * @returns 通过绕行验证的有限候选，最终仍须完整双向覆盖；退化返回空数组。
 * @throws 数值库异常向上传播，不回退成未经校验的角点拼接。
 */
export function fitRoundedContours(
  sampled: readonly FitPoint[],
  trace: readonly FitPoint[],
  observations: readonly FitPoint[],
  initial: readonly FitPoint[],
  uncertainty: number,
): RoundedContourFit[] {
  const [a, b, c] = initial;
  if (!a || !b || !c) return [];
  const width = distance(a, b) / 2,
    height = distance(b, c) / 2,
    center = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 },
    angle = Math.atan2(b.y - a.y, b.x - a.x);
  const data = [...sampled, ...observations],
    result: RoundedContourFit[] = [];
  const starts: Array<{ capsule: boolean; parameters: number[] }> = [];
  for (const ratio of [0.25, 0.6, 0.9])
    starts.push({
      capsule: false,
      parameters: [
        center.x,
        center.y,
        Math.log(width),
        Math.log(height),
        angle,
        Math.log(ratio / (1 - ratio)),
      ],
    });
  const long = Math.max(width, height),
    short = Math.min(width, height);
  if (long - short > 0.04)
    starts.push({
      capsule: true,
      parameters: [
        center.x,
        center.y,
        Math.log(long - short),
        Math.log(short),
        angle + (height > width ? Math.PI / 2 : 0),
      ],
    });
  for (const start of starts) {
    const parameters = optimizeGeometry(
      start.parameters,
      (p) => {
        const fit = geometry(p, start.capsule);
        return fit ? data.map((point) => boundaryDistance(point, fit)) : null;
      },
      uncertainty,
      0.075,
      undefined,
      undefined,
      sampled.length,
    );
    const fit = parameters ? geometry(parameters, start.capsule) : null,
      points = fit ? contour(fit, trace) : null;
    if (points && fit && supportedSides(sampled, fit))
      result.push({
        label: start.capsule ? "capsule" : "rounded-rectangle",
        points,
        parameters: start.parameters.length,
      });
  }
  return result;
}
