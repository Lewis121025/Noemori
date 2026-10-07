import { ellipseContour, ellipseDistance, type EllipseGeometry } from "./fitting-conics";
import { distance, resample, segmentDistance, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";
import type { ScenePrimitive } from "./fitting-primitives";
import type { SceneFit, SceneFrame } from "./fitting-scene";

type Rim = Extract<ScenePrimitive, { kind: "circle" | "ellipse" }>;
const ellipse = (rim: Rim): EllipseGeometry =>
  rim.kind === "ellipse"
    ? rim.geometry
    : {
        center: rim.geometry.center,
        major: rim.geometry.radius,
        minor: rim.geometry.radius,
        angle: 0,
      };
/** 由共同椭圆二次型计算沿挤出方向的精确支持点，两侧连线必然与两圈相切。 */
function support(a: number, b: number, angle: number, dx: number, dy: number): FitPoint | null {
  const length = Math.hypot(dx, dy);
  if (length < 0.06) return null;
  const nx = -dy / length,
    ny = dx / length,
    c = Math.cos(angle),
    s = Math.sin(angle),
    u = nx * c + ny * s,
    v = -nx * s + ny * c,
    d = Math.hypot(a * u, b * v);
  if (d < 1e-8) return null;
  return { x: (a * a * u * c - b * b * v * s) / d, y: (a * a * u * s + b * b * v * c) / d };
}
/**
 * 两个同投影圆截面和两条相切侧线共同拟合圆柱线框，也接受只露出半个底圈。
 * @param frame 共用归一化与完整观测的场景。
 * @param primitives 通过全观测验收的圆锥边界和直线。
 * @returns 接点支持的圆柱候选；无双圈/双侧线或歧义组合返回空数组。
 * @throws 数值错误传播，输出仍由逐笔双向覆盖验收。
 */
export function fitCylinders(frame: SceneFrame, primitives: readonly ScenePrimitive[]): SceneFit[] {
  const rims = primitives.filter((p): p is Rim => p.kind === "circle" || p.kind === "ellipse"),
    lines = primitives.filter((p) => p.kind === "line"),
    result: SceneFit[] = [];
  for (let i = 0; i < rims.length; i++)
    for (let j = i + 1; j < rims.length; j++) {
      const first = rims[i]!,
        second = rims[j]!,
        a = ellipse(first),
        b = ellipse(second),
        dx = b.center.x - a.center.x,
        dy = b.center.y - a.center.y;
      if (Math.abs(a.major - b.major) > 0.04 || Math.abs(a.minor - b.minor) > 0.04) continue;
      const q = support((a.major + b.major) / 2, (a.minor + b.minor) / 2, a.angle, dx, dy);
      if (!q) continue;
      const initialSides = [-1, 1].map((side) => [
        { x: a.center.x + side * q.x, y: a.center.y + side * q.y },
        { x: b.center.x + side * q.x, y: b.center.y + side * q.y },
      ]);
      const selected = initialSides.map((side) =>
        lines.filter(
          (line) =>
            Math.min(
              distance(line.points[0]!, side[0]!) + distance(line.points[1]!, side[1]!),
              distance(line.points[0]!, side[1]!) + distance(line.points[1]!, side[0]!),
            ) < 0.1,
        ),
      );
      if (selected.some((s) => s.length !== 1) || selected[0]![0] === selected[1]![0]) continue;
      const members = [first, second, selected[0]![0]!, selected[1]![0]!];
      if (!members.some((p) => p.trace.index === 0)) continue;
      const sampled = members.flatMap((member, owner) =>
          resample(member.trace.points, 64).map((point) => ({ point, owner })),
        ),
        observed = members.flatMap((member, owner) =>
          member.trace.observations.map((point) => ({ point, owner })),
        ),
        data = [...sampled, ...observed];
      const geometry = (p: readonly number[]) => {
        const major = Math.exp(p[2]!),
          minor = major / (1 + Math.exp(-p[3]!)),
          center = { x: p[0]!, y: p[1]! },
          other = { x: p[0]! + p[5]!, y: p[1]! + p[6]! },
          q = support(major, minor, p[4]!, p[5]!, p[6]!);
        if (!p.every(Number.isFinite) || !q || minor < 0.025 || major > 2) return null;
        return {
          rims: [
            { center, major, minor, angle: p[4]! },
            { center: other, major, minor, angle: p[4]! },
          ],
          sides: [-1, 1].map((side) => [
            { x: center.x + side * q.x, y: center.y + side * q.y },
            { x: other.x + side * q.x, y: other.y + side * q.y },
          ]),
        };
      };
      const ratio = Math.min(0.999, (a.minor + b.minor) / (a.major + b.major)),
        initial = [
          a.center.x,
          a.center.y,
          Math.log((a.major + b.major) / 2),
          Math.log(ratio / (1 - ratio)),
          a.angle,
          dx,
          dy,
        ];
      const fit = optimizeGeometry(
          initial,
          (p) => {
            const g = geometry(p);
            return g
              ? data.map(({ point, owner }) =>
                  owner < 2
                    ? ellipseDistance(point, g.rims[owner]!)
                    : segmentDistance(point, g.sides[owner - 2]![0]!, g.sides[owner - 2]![1]!),
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
      const paths = new Map<number, FitPoint[]>();
      for (let owner = 0; owner < 4; owner++) {
        const member = members[owner]!;
        if (owner < 2) {
          const rim = g.rims[owner]!,
            start = member.trace.points[0]!,
            x = start.x - rim.center.x,
            y = start.y - rim.center.y,
            angle = Math.atan2(
              (-x * Math.sin(rim.angle) + y * Math.cos(rim.angle)) / rim.minor,
              (x * Math.cos(rim.angle) + y * Math.sin(rim.angle)) / rim.major,
            ),
            sweep = member.kind === "ellipse" ? member.sweep : 2 * Math.PI;
          paths.set(member.trace.index, ellipseContour(rim, angle, sweep));
        } else {
          const side = g.sides[owner - 2]!;
          paths.set(
            member.trace.index,
            distance(member.trace.points[0]!, side[0]!) <
              distance(member.trace.points[0]!, side[1]!)
              ? side
              : [...side].reverse(),
          );
        }
      }
      result.push({ label: "cylinder", paths, parameters: 7 });
    }
  return result;
}
