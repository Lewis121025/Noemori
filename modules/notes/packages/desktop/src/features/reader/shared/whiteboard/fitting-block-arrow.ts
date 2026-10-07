import { polygonDistance } from "./fitting-polygon-distance";
import { distance, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";

/** 闭合箭头共享中轴、头宽、杆宽；双箭头还共享两端的头长。 */
export type BlockArrowFit = { label: "arrow"; points: FitPoint[]; parameters: number };
function contour(p: readonly number[], double: boolean): FitPoint[] | null {
  const length = Math.exp(p[2]!),
    head = length / (2 + Math.exp(-p[3]!)),
    shaft = Math.exp(p[4]!),
    wing = shaft + Math.exp(p[5]!);
  if (
    !p.every(Number.isFinite) ||
    length < 0.3 ||
    length > 3 ||
    head < 0.03 ||
    shaft < 0.015 ||
    wing > length * 0.6
  )
    return null;
  const l = length / 2,
    neck = l - head;
  const local = double
    ? [
        [-l, 0],
        [-neck, -wing],
        [-neck, -shaft],
        [neck, -shaft],
        [neck, -wing],
        [l, 0],
        [neck, wing],
        [neck, shaft],
        [-neck, shaft],
        [-neck, wing],
      ]
    : [
        [-l, -shaft],
        [neck, -shaft],
        [neck, -wing],
        [l, 0],
        [neck, wing],
        [neck, shaft],
        [-l, shaft],
      ];
  const angle = p[6]!,
    c = Math.cos(angle),
    s = Math.sin(angle),
    points = local.map(([x, y]) => ({ x: p[0]! + x! * c - y! * s, y: p[1]! + x! * s + y! * c }));
  points.push(points[0]!);
  return points;
}
/**
 * 由闭合轮廓的凹角对应关系拟合实心/轮廓单或双箭头，不用任意像素模板匹配。
 * @param sampled 归一化等弧长轮廓。
 * @param corners 原顺序真实角点，首尾重复。
 * @param observations 全部真实观测。
 * @param uncertainty 归一化定位不确定性。
 * @returns 中轴对称的闭合箭头候选；无对应凹角或比例退化返回空数组。
 * @throws 数值错误向上传播，覆盖和绕行仍由共同验收负责。
 */
export function fitBlockArrows(
  sampled: readonly FitPoint[],
  corners: readonly FitPoint[],
  observations: readonly FitPoint[],
  uncertainty: number,
): BlockArrowFit[] {
  const vertices = corners.slice(0, -1),
    double = vertices.length === 10;
  if (!double && vertices.length !== 7) return [];
  const result: BlockArrowFit[] = [],
    data = [...sampled, ...observations];
  for (const order of [vertices, [...vertices].reverse()])
    for (let shift = 0; shift < order.length; shift++) {
      const points = order.map((_, i) => order[(i + shift) % order.length]!),
        tip = points[double ? 5 : 3]!,
        tail = double
          ? points[0]!
          : { x: (points[0]!.x + points[6]!.x) / 2, y: (points[0]!.y + points[6]!.y) / 2 },
        length = distance(tip, tail);
      if (length < 0.3) continue;
      const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x),
        center = { x: (tip.x + tail.x) / 2, y: (tip.y + tail.y) / 2 },
        c = Math.cos(angle),
        s = Math.sin(angle),
        local = points.map((p) => ({
          x: (p.x - center.x) * c + (p.y - center.y) * s,
          y: -(p.x - center.x) * s + (p.y - center.y) * c,
        })),
        head = length / 2 - local[double ? 4 : 2]!.x,
        shaft = Math.abs(local[double ? 3 : 1]!.y),
        wing = Math.abs(local[double ? 4 : 2]!.y);
      if (head <= 0.03 || head >= length / 2 || shaft <= 0.015 || wing <= shaft + 0.01) continue;
      const initial = [
          center.x,
          center.y,
          Math.log(length),
          -Math.log(length / head - 2),
          Math.log(shaft),
          Math.log(wing - shaft),
          angle,
        ],
        guide = contour(initial, double);
      if (!guide || points.some((p, i) => distance(p, guide[i]!) > Math.max(0.04, 3 * uncertainty)))
        continue;
      const fit = optimizeGeometry(
          initial,
          (p) => {
            const outline = contour(p, double);
            return outline ? data.map((point) => polygonDistance(point, outline)) : null;
          },
          uncertainty,
          0.065,
          undefined,
          undefined,
          sampled.length,
        ),
        outline = fit ? contour(fit, double) : null;
      if (outline) result.push({ label: "arrow", points: outline, parameters: 7 });
    }
  return result;
}
