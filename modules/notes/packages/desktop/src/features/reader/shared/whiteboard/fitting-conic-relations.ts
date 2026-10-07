import { ellipseContour, ellipseDistance, type EllipseGeometry } from "./fitting-conics";
import { distance, resample, type FitPoint } from "./fitting-math";
import { lineEndpoints, type ScenePrimitive } from "./fitting-primitives";
import { optimizeGeometry } from "./fitting-optimization";
import type { SceneFrame, SceneFit } from "./fitting-scene";

type Ellipse = Extract<ScenePrimitive, { kind: "ellipse" }>;
type Line = Extract<ScenePrimitive, { kind: "line" }>;
function ellipseAt(
  p: readonly number[],
  at: number,
  center: FitPoint,
  angle: number,
): EllipseGeometry | null {
  const major = Math.exp(p[at]!),
    minor = major / (1 + Math.exp(-p[at + 1]!));
  return major > 2 || minor < 0.005 ? null : { center, major, minor, angle };
}
const ratioParameter = (g: EllipseGeometry) =>
  Math.log(Math.min(0.999, g.minor / g.major) / (1 - Math.min(0.999, g.minor / g.major)));
function render(g: EllipseGeometry, trace: Ellipse): FitPoint[] {
  const first = trace.trace.points[0]!,
    x = first.x - g.center.x,
    y = first.y - g.center.y,
    angle = Math.atan2(
      (-x * Math.sin(g.angle) + y * Math.cos(g.angle)) / g.minor,
      (x * Math.cos(g.angle) + y * Math.sin(g.angle)) / g.major,
    );
  return ellipseContour(g, angle, trace.sweep);
}
function concentric(a: Ellipse, b: Ellipse, uncertainty: number): SceneFit | null {
  const ga = a.geometry,
    gb = b.geometry,
    delta =
      Math.abs(
        Math.atan2(Math.sin(2 * (ga.angle - gb.angle)), Math.cos(2 * (ga.angle - gb.angle))),
      ) / 2;
  if (
    Math.abs(a.sweep) < 6 ||
    Math.abs(b.sweep) < 6 ||
    distance(ga.center, gb.center) > 0.025 ||
    delta > 0.065 ||
    !((ga.major < gb.major && ga.minor < gb.minor) || (ga.major > gb.major && ga.minor > gb.minor))
  )
    return null;
  const center = { x: (ga.center.x + gb.center.x) / 2, y: (ga.center.y + gb.center.y) / 2 },
    initial = [
      center.x,
      center.y,
      Math.log(ga.major),
      ratioParameter(ga),
      Math.log(gb.major),
      ratioParameter(gb),
      ga.angle,
    ];
  const members = [a, b],
    sampled = members.flatMap((s, owner) =>
      resample(s.trace.points, 96).map((point) => ({ point, owner })),
    ),
    observed = members.flatMap((s, owner) =>
      s.trace.observations.map((point) => ({ point, owner })),
    ),
    data = [...sampled, ...observed];
  const geometry = (p: readonly number[]) => {
    if (!p.every(Number.isFinite)) return null;
    const center = { x: p[0]!, y: p[1]! },
      a = ellipseAt(p, 2, center, p[6]!),
      b = ellipseAt(p, 4, center, p[6]!);
    return a && b ? [a, b] : null;
  };
  const fitted = optimizeGeometry(
      initial,
      (p) => {
        const g = geometry(p);
        return g ? data.map(({ point, owner }) => ellipseDistance(point, g[owner]!)) : null;
      },
      uncertainty,
      0.04,
      undefined,
      undefined,
      192,
    ),
    g = fitted ? geometry(fitted) : null;
  return g
    ? {
        label: "ring",
        parameters: 7,
        paths: new Map(members.map((m, i) => [m.trace.index, render(g[i]!, m)])),
      }
    : null;
}
function tangent(line: Line, ellipse: Ellipse, uncertainty: number): SceneFit | null {
  const g = ellipse.geometry,
    theta = line.geometry.angle,
    c = Math.cos(g.angle),
    s = Math.sin(g.angle),
    n = { x: -Math.sin(theta), y: Math.cos(theta) },
    support = Math.hypot(g.major * (n.x * c + n.y * s), g.minor * (-n.x * s + n.y * c)),
    signed =
      (g.center.x - line.geometry.center.x) * n.x + (g.center.y - line.geometry.center.y) * n.y;
  if (Math.abs(Math.abs(signed) - support) > 0.025 || Math.abs(ellipse.sweep) < 6) return null;
  const localX = n.x * c + n.y * s,
    localY = -n.x * s + n.y * c,
    q = {
      x: (g.major ** 2 * localX * c - g.minor ** 2 * localY * s) / support,
      y: (g.major ** 2 * localX * s + g.minor ** 2 * localY * c) / support,
    },
    side = Math.sign(signed),
    foot = { x: g.center.x - side * q.x, y: g.center.y - side * q.y },
    a = line.points[0]!,
    b = line.points[1]!,
    along = ((foot.x - a.x) * (b.x - a.x) + (foot.y - a.y) * (b.y - a.y)) / distance(a, b) ** 2;
  if (along < -0.02 || along > 1.02) return null;
  const sampled = [resample(line.trace.points, 96), resample(ellipse.trace.points, 96)],
    data = [
      ...sampled[0]!,
      ...sampled[1]!,
      ...line.trace.observations,
      ...ellipse.trace.observations,
    ],
    owner = data.map((_, i) =>
      i < 192 ? (i < 96 ? 0 : 1) : i - 192 < line.trace.observations.length ? 0 : 1,
    ),
    initial = [g.center.x, g.center.y, Math.log(g.major), ratioParameter(g), g.angle, theta];
  const geometry = (p: readonly number[]) => {
    if (!p.every(Number.isFinite)) return null;
    const center = { x: p[0]!, y: p[1]! },
      ellipse = ellipseAt(p, 2, center, p[4]!);
    if (!ellipse) return null;
    const n = { x: -Math.sin(p[5]!), y: Math.cos(p[5]!) },
      c = Math.cos(p[4]!),
      s = Math.sin(p[4]!),
      h = Math.hypot(ellipse.major * (n.x * c + n.y * s), ellipse.minor * (-n.x * s + n.y * c));
    return { ellipse, n, h, theta: p[5]! };
  };
  const fit = optimizeGeometry(
      initial,
      (p) => {
        const geometryValue = geometry(p);
        return geometryValue
          ? data.map((point, i) =>
              owner[i] === 1
                ? ellipseDistance(point, geometryValue.ellipse)
                : (point.x - geometryValue.ellipse.center.x) * geometryValue.n.x +
                  (point.y - geometryValue.ellipse.center.y) * geometryValue.n.y +
                  side * geometryValue.h,
            )
          : null;
      },
      uncertainty,
      0.04,
      undefined,
      undefined,
      192,
    ),
    result = fit ? geometry(fit) : null;
  if (!result) return null;
  return {
    label: "ellipse",
    parameters: 8,
    paths: new Map([
      [
        line.trace.index,
        lineEndpoints(line.trace, {
          angle: result.theta,
          center: {
            x: result.ellipse.center.x - side * result.h * result.n.x,
            y: result.ellipse.center.y - side * result.h * result.n.y,
          },
        }),
      ],
      [ellipse.trace.index, render(result.ellipse, ellipse)],
    ]),
  };
}
/**
 * 椭圆共享中心/轴方向或与支持线精确相切；开放弧保留给相应复合几何。
 * @param frame 同一归一化场景。
 * @param primitives 全观测校验的基元。
 * @returns 涉及活动笔迹的候选；未证明的嵌套或接触不强制约束。
 * @throws 数值错误向上传播。
 */
export function fitConicRelations(
  frame: SceneFrame,
  primitives: readonly ScenePrimitive[],
): SceneFit[] {
  const active = primitives.find((p) => p.trace.index === 0);
  if (!active) return [];
  const uncertainty = Math.min(0.01, 3 / (frame.size * frame.scale)),
    result: SceneFit[] = [];
  for (const other of primitives) {
    if (active === other) continue;
    const fit =
      active.kind === "ellipse" && other.kind === "ellipse"
        ? concentric(active, other, uncertainty)
        : active.kind === "line" && other.kind === "ellipse"
          ? tangent(active, other, uncertainty)
          : active.kind === "ellipse" && other.kind === "line"
            ? tangent(other, active, uncertainty)
            : null;
    if (fit) result.push(fit);
  }
  return result;
}
