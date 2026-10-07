import { circleContour } from "./fitting-conics";
import { distance, resample, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";
import { lineEndpoints, type ScenePrimitive } from "./fitting-primitives";
import type { SceneFit, SceneFrame } from "./fitting-scene";

type Line = Extract<ScenePrimitive, { kind: "line" }>;
type Circle = Extract<ScenePrimitive, { kind: "circle" }>;
const angleDifference = (a: number, b: number) =>
  Math.abs(Math.atan2(Math.sin(2 * (a - b)), Math.cos(2 * (a - b)))) / 2;

function linePair(a: Line, b: Line, uncertainty: number): SceneFit | null {
  const delta = angleDifference(a.geometry.angle, b.geometry.angle),
    perpendicular = Math.abs(delta - Math.PI / 2) < 0.065;
  if (delta > 0.065 && !perpendicular) return null;
  const angle = a.geometry.angle,
    shift = perpendicular ? Math.PI / 2 : 0;
  const offset = (line: Line, angle: number) =>
    line.geometry.center.y * Math.cos(angle) - line.geometry.center.x * Math.sin(angle);
  const data = [a, b].map((line) => resample(line.trace.points, 96)),
    observed = [...a.trace.observations, ...b.trace.observations];
  const samples = [...data[0]!, ...data[1]!, ...observed];
  const owner = samples.map((_, i) =>
    i < 192 ? (i < 96 ? 0 : 1) : i - 192 < a.trace.observations.length ? 0 : 1,
  );
  const fit = optimizeGeometry(
    [angle, offset(a, angle), offset(b, angle + shift)],
    (p) =>
      samples.map((point, i) => {
        const j = owner[i]!,
          theta = p[0]! + (j ? shift : 0);
        return point.y * Math.cos(theta) - point.x * Math.sin(theta) - p[1 + j]!;
      }),
    uncertainty,
    0.04,
    undefined,
    undefined,
    192,
  );
  if (!fit) return null;
  const paths = new Map<number, FitPoint[]>();
  for (const [i, line] of [a, b].entries()) {
    const theta = fit[0]! + (i ? shift : 0),
      center = { x: -Math.sin(theta) * fit[1 + i]!, y: Math.cos(theta) * fit[1 + i]! };
    paths.set(line.trace.index, lineEndpoints(line.trace, { center, angle: theta }));
  }
  if (!perpendicular) {
    // 相同端部支持线提供对齐/镜像证据；明显不同长度不强制等长。
    const direction = { x: Math.cos(fit[0]!), y: Math.sin(fit[0]!) },
      project = (point: FitPoint) => point.x * direction.x + point.y * direction.y;
    const endpoints = [...paths.values()].map((points) =>
      points.map(project).sort((a, b) => a - b),
    );
    const aligned = [0, 1].map((i) => Math.abs(endpoints[0]![i]! - endpoints[1]![i]!) < 0.02);
    for (const [i, line] of [a, b].entries()) {
      const points = paths.get(line.trace.index)!;
      paths.set(
        line.trace.index,
        points.map((point) => {
          const t = project(point),
            at = Math.abs(t - endpoints[i]![0]!) < Math.abs(t - endpoints[i]![1]!) ? 0 : 1;
          const target = aligned[at] ? (endpoints[0]![at]! + endpoints[1]![at]!) / 2 : t;
          return {
            x: point.x + (target - t) * direction.x,
            y: point.y + (target - t) * direction.y,
          };
        }),
      );
    }
  }
  return { label: "polyline", paths, parameters: 7 };
}

function circlePair(a: Circle, b: Circle, uncertainty: number): SceneFit | null {
  const separation = distance(a.geometry.center, b.geometry.center),
    r1 = a.geometry.radius,
    r2 = b.geometry.radius;
  const concentric = separation < 0.035 && Math.abs(r1 - r2) > 0.025;
  const external = Math.abs(separation - r1 - r2) < 0.025,
    internal = Math.abs(separation - Math.abs(r1 - r2)) < 0.025 && separation > 0.06;
  if (!concentric && !external && !internal) return null;
  const theta = Math.atan2(
      b.geometry.center.y - a.geometry.center.y,
      b.geometry.center.x - a.geometry.center.x,
    ),
    initial = concentric
      ? [
          (a.geometry.center.x + b.geometry.center.x) / 2,
          (a.geometry.center.y + b.geometry.center.y) / 2,
          Math.log(r1),
          Math.log(r2),
        ]
      : [a.geometry.center.x, a.geometry.center.y, Math.log(r1), Math.log(r2), theta];
  const geometry = (p: readonly number[]) => {
    const first = { x: p[0]!, y: p[1]! },
      r1 = Math.exp(p[2]!),
      r2 = Math.exp(p[3]!),
      d = concentric ? 0 : external ? r1 + r2 : Math.abs(r1 - r2);
    if (!p.every(Number.isFinite) || Math.min(r1, r2) < 0.015 || Math.max(r1, r2) > 3) return null;
    return [
      { center: first, radius: r1 },
      {
        center: { x: first.x + d * Math.cos(p[4] ?? 0), y: first.y + d * Math.sin(p[4] ?? 0) },
        radius: r2,
      },
    ];
  };
  const sampled = [resample(a.trace.points, 96), resample(b.trace.points, 96)],
    data = [...sampled[0]!, ...sampled[1]!, ...a.trace.observations, ...b.trace.observations],
    owner = data.map((_, i) =>
      i < 192 ? (i < 96 ? 0 : 1) : i - 192 < a.trace.observations.length ? 0 : 1,
    );
  const fit = optimizeGeometry(
      initial,
      (p) => {
        const g = geometry(p);
        return g
          ? data.map((point, i) => distance(point, g[owner[i]!]!.center) - g[owner[i]!]!.radius)
          : null;
      },
      uncertainty,
      0.04,
      undefined,
      undefined,
      192,
    ),
    g = fit ? geometry(fit) : null;
  if (!g) return null;
  const paths = new Map<number, FitPoint[]>();
  for (const [i, line] of [a, b].entries()) {
    const circle = g[i]!,
      start = line.trace.points[0]!,
      before = line.trace.points[1]!,
      dx = start.x - circle.center.x,
      dy = start.y - circle.center.y,
      sweep =
        dx * (before.y - start.y) - dy * (before.x - start.x) > 0 ? 2 * Math.PI : -2 * Math.PI;
    paths.set(line.trace.index, circleContour(circle, Math.atan2(dy, dx), sweep));
  }
  return { label: concentric ? "ring" : "circle", paths, parameters: initial.length };
}

function lineCircle(line: Line, circle: Circle, uncertainty: number): SceneFit | null {
  const theta = line.geometry.angle,
    n = { x: -Math.sin(theta), y: Math.cos(theta) },
    offset = line.geometry.center.x * n.x + line.geometry.center.y * n.y,
    signed = circle.geometry.center.x * n.x + circle.geometry.center.y * n.y - offset;
  if (Math.abs(Math.abs(signed) - circle.geometry.radius) > 0.025) return null;
  const foot = {
      x: circle.geometry.center.x - signed * n.x,
      y: circle.geometry.center.y - signed * n.y,
    },
    ends = line.points,
    dx = ends[1]!.x - ends[0]!.x,
    dy = ends[1]!.y - ends[0]!.y,
    t = ((foot.x - ends[0]!.x) * dx + (foot.y - ends[0]!.y) * dy) / (dx * dx + dy * dy);
  if (t < -0.02 || t > 1.02) return null;
  const side = Math.sign(signed),
    sampled = [resample(line.trace.points, 96), resample(circle.trace.points, 96)],
    data = [
      ...sampled[0]!,
      ...sampled[1]!,
      ...line.trace.observations,
      ...circle.trace.observations,
    ],
    owner = data.map((_, i) =>
      i < 192 ? (i < 96 ? 0 : 1) : i - 192 < line.trace.observations.length ? 0 : 1,
    );
  const initial = [
      circle.geometry.center.x,
      circle.geometry.center.y,
      Math.log(circle.geometry.radius),
      theta,
    ],
    fit = optimizeGeometry(
      initial,
      (p) => {
        const radius = Math.exp(p[2]!),
          n = { x: -Math.sin(p[3]!), y: Math.cos(p[3]!) };
        return data.map((point, i) =>
          owner[i] === 1
            ? Math.hypot(point.x - p[0]!, point.y - p[1]!) - radius
            : (point.x - p[0]!) * n.x + (point.y - p[1]!) * n.y + side * radius,
        );
      },
      uncertainty,
      0.04,
      undefined,
      undefined,
      192,
    );
  if (!fit) return null;
  const center = { x: fit[0]!, y: fit[1]! },
    radius = Math.exp(fit[2]!),
    normal = { x: -Math.sin(fit[3]!), y: Math.cos(fit[3]!) },
    start = circle.trace.points[0]!;
  const linePoints = lineEndpoints(line.trace, {
    angle: fit[3]!,
    center: { x: center.x - side * radius * normal.x, y: center.y - side * radius * normal.y },
  });
  return {
    label: "circle",
    paths: new Map([
      [line.trace.index, linePoints],
      [
        circle.trace.index,
        circleContour(
          { center, radius },
          Math.atan2(start.y - center.y, start.x - center.x),
          2 * Math.PI,
        ),
      ],
    ]),
    parameters: 6,
  };
}

/**
 * 用共享参数强制平行、垂直、同心、相切，以及有端点支持的对齐/对称。
 * @param frame 完整归一化场景，未提供几何证据的笔迹不会被移动。
 * @param primitives 全观测验收后的基元。
 * @returns 涉及活动笔画的候选；近似关系门槛只生成候选，最终仍逐笔验收。
 */
export function fitRelations(frame: SceneFrame, primitives: readonly ScenePrimitive[]): SceneFit[] {
  const active = primitives.find((p) => p.trace.index === 0);
  if (!active) return [];
  const uncertainty = Math.min(0.015, 3 / (frame.size * frame.scale)),
    result: SceneFit[] = [];
  for (const other of primitives) {
    if (other === active) continue;
    const candidate =
      active.kind === "line" && other.kind === "line"
        ? linePair(active, other, uncertainty)
        : active.kind === "circle" && other.kind === "circle"
          ? circlePair(active, other, uncertainty)
          : active.kind === "line" && other.kind === "circle"
            ? lineCircle(active, other, uncertainty)
            : active.kind === "circle" && other.kind === "line"
              ? lineCircle(other, active, uncertainty)
              : null;
    if (candidate) result.push(candidate);
  }
  return result;
}
