import { describe, expect, it } from "vitest";
import { repairScene } from "@reader/shared/whiteboard/fitting-scene";
import { contourDeviation } from "@reader/shared/whiteboard/fitting-math";
import type { InkPoint } from "@reader/shared/whiteboard/model";
const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const edge = (a: InkPoint, b: InkPoint) =>
  Array.from({ length: 49 }, (_, i) =>
    p(
      a.x + ((b.x - a.x) * i) / 48 + 0.2 * Math.sin(i * 1.3),
      a.y + ((b.y - a.y) * i) / 48 + 0.2 * Math.sin(i * 1.7),
    ),
  );
const circle = (cx: number, cy: number, r: number) =>
  Array.from({ length: 193 }, (_, i) =>
    p(cx + r * Math.cos((2 * Math.PI * i) / 192), cy + r * Math.sin((2 * Math.PI * i) / 192)),
  );
function run(paths: InkPoint[][]) {
  return repairScene({
    points: paths[0]!,
    observations: paths[0]!,
    scale: 1,
    context: paths.slice(1).map((points, i) => ({ id: String(i), points, observations: points })),
  });
}
const center = (points: readonly InkPoint[]) => {
  const v = points.slice(0, -1);
  return p(v.reduce((s, p) => s + p.x, 0) / v.length, v.reduce((s, p) => s + p.y, 0) / v.length);
};
describe("多笔画精确关系", () => {
  it("接近平行和对齐的两笔恢复共同方向、支持线与镜像长度", () => {
    const fit = run([edge(p(0, 0), p(200, 1)), edge(p(1, 80), p(201, 79))])!;
    expect(fit.replacements).toHaveLength(1);
    const a = fit.points,
      b = fit.replacements![0]!.points,
      dx = a[1]!.x - a[0]!.x,
      dy = a[1]!.y - a[0]!.y;
    expect(dx * (b[1]!.y - b[0]!.y) - dy * (b[1]!.x - b[0]!.x)).toBeCloseTo(0, 7);
    expect(Math.hypot(dx, dy)).toBeCloseTo(Math.hypot(b[1]!.x - b[0]!.x, b[1]!.y - b[0]!.y), 8);
  });
  it("独立近垂直线保持交叉位置并恢复直角", () => {
    const fit = run([edge(p(-100, 0), p(100, 2)), edge(p(1, -80), p(-1, 80))])!;
    expect(fit.replacements).toHaveLength(1);
    const a = fit.points,
      b = fit.replacements![0]!.points;
    expect(
      (a[1]!.x - a[0]!.x) * (b[1]!.x - b[0]!.x) + (a[1]!.y - a[0]!.y) * (b[1]!.y - b[0]!.y),
    ).toBeCloseTo(0, 7);
  });
  it("圆环和圆形孔洞用同一圆心，保留两条独立闭合笔迹", () => {
    const fit = run([circle(1, 0, 100), circle(0, 1, 60)])!;
    expect(fit.label).toBe("ring");
    expect(fit.replacements).toHaveLength(1);
    const a = center(fit.points),
      b = center(fit.replacements![0]!.points);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-7);
    expect(fit.points[0]).toEqual(fit.points.at(-1));
  });
  it("外切圆通过共同接点，不以近似包围盒判断相切", () => {
    const fit = run([circle(0, 0, 70), circle(121, 0, 50)])!;
    expect(fit.replacements).toHaveLength(1);
    const a = center(fit.points),
      b = center(fit.replacements![0]!.points),
      ra = Math.hypot(fit.points[0]!.x - a.x, fit.points[0]!.y - a.y),
      rb = Math.hypot(
        fit.replacements![0]!.points[0]!.x - b.x,
        fit.replacements![0]!.points[0]!.y - b.y,
      );
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(ra + rb, 7);
  });
  it("圆与直线联合恢复精确相切", () => {
    const fit = run([edge(p(-120, 101), p(120, 102)), circle(0, 0, 100)])!;
    expect(fit.replacements).toHaveLength(1);
    const a = fit.points,
      c = center(fit.replacements![0]!.points),
      dx = a[1]!.x - a[0]!.x,
      dy = a[1]!.y - a[0]!.y,
      r = Math.hypot(
        fit.replacements![0]!.points[0]!.x - c.x,
        fit.replacements![0]!.points[0]!.y - c.y,
      );
    expect(Math.abs((c.x - a[0]!.x) * dy - (c.y - a[0]!.y) * dx) / Math.hypot(dx, dy)).toBeCloseTo(
      r,
      7,
    );
  });
  it("明显不成立的角度/同心关系保持独立，不扩张修形预算", () => {
    expect(
      run([edge(p(0, 0), p(200, 20)), edge(p(0, 80), p(200, 120))])?.replacements,
    ).toBeUndefined();
    const nested = run([circle(0, 0, 100), circle(25, 20, 50)])!;
    expect(nested.label).not.toBe("ring");
    if (nested.replacements) {
      const a = center(nested.points),
        b = center(nested.replacements[0]!.points);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30);
    }
  });
  it.each([false, true])("长方体线框保留八个三价接点和投影结构 %s", (perspective) => {
    const nodes = Array.from({ length: 8 }, (_, i) => {
      const x = (i & 1) * 180 + ((i >> 2) & 1) * 55,
        y = ((i >> 1) & 1) * 130 - ((i >> 2) & 1) * 45,
        d = perspective ? 1 + (i & 1) * 0.18 + ((i >> 2) & 1) * 0.12 : 1;
      return p(x / d, y / d);
    });
    const paths: InkPoint[][] = [];
    for (let i = 0; i < 8; i++)
      for (const bit of [1, 2, 4])
        if ((i & bit) === 0) paths.push(edge(nodes[i]!, nodes[i | bit]!));
    const fit = run(paths)!;
    expect(fit.label).toBe("wireframe");
    expect(fit.replacements).toHaveLength(11);
    const outputs = [fit.points, ...fit.replacements!.map((s) => s.points)];
    const all = outputs.flat();
    for (const end of all)
      expect(all.filter((q) => Math.hypot(q.x - end.x, q.y - end.y) < 1e-7)).toHaveLength(3);
    expect(outputs.every((s) => s.length === 2)).toBe(true);
    for (const [i, points] of fit.replacements!.entries())
      expect(contourDeviation(paths[Number(points.id) + 1]!, points.points)!.rms).toBeLessThan(1);
  });
  it("椭圆环共用中心和长轴方向，保留内外轴比", () => {
    const ellipse = (cx: number, cy: number, a: number, b: number, rotation: number) =>
        Array.from({ length: 193 }, (_, i) => {
          const t = (i * 2 * Math.PI) / 192,
            x = a * Math.cos(t),
            y = b * Math.sin(t);
          return p(
            cx + x * Math.cos(rotation) - y * Math.sin(rotation),
            cy + x * Math.sin(rotation) + y * Math.cos(rotation),
          );
        }),
      fit = run([ellipse(0, 1, 110, 60, 0.35), ellipse(1, 0, 65, 30, 0.36)])!;
    expect(fit.label).toBe("ring");
    const a = center(fit.points),
      b = center(fit.replacements![0]!.points);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-7);
  });
  it("椭圆与支持线联合恢复相切，不能按圆半径替代椭圆支持函数", () => {
    const ellipse = Array.from({ length: 193 }, (_, i) =>
        p(110 * Math.cos((i * 2 * Math.PI) / 192), 60 * Math.sin((i * 2 * Math.PI) / 192)),
      ),
      fit = run([edge(p(-130, 61), p(130, 62)), ellipse])!;
    expect(fit.label).toBe("ellipse");
    expect(fit.replacements).toHaveLength(1);
    expect(contourDeviation(ellipse, fit.replacements![0]!.points)!.rms).toBeLessThan(1.5);
  });
  it("不同形状的带孔轮廓保留独立闭合边界，不补连接线", () => {
    const outer = [
      ...edge(p(-140, -100), p(140, -100)),
      ...edge(p(140, -100), p(160, 90)),
      ...edge(p(160, 90), p(-150, 90)),
      ...edge(p(-150, 90), p(-140, -100)),
    ];
    outer.push(outer[0]!);
    const fit = run([circle(5, 3, 40), outer])!;
    expect(fit.replacements).toHaveLength(1);
    for (const points of [fit.points, fit.replacements![0]!.points])
      expect(points[0]).toEqual(points.at(-1));
  });
  it("巨大邻近轮廓不能放大小圆的修复预算或制造同心意图", () => {
    const fit = run([circle(250, 0, 40), circle(0, 0, 10000)])!;
    const small = center(fit.points);
    expect(Math.abs(small.x - 250)).toBeLessThan(1);
    if (fit.replacements) {
      const outer = center(fit.replacements[0]!.points);
      expect(Math.abs(outer.x)).toBeLessThan(1);
    }
  });
});
