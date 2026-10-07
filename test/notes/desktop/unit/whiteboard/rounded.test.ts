import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import { contourDeviation } from "@reader/shared/whiteboard/fitting-math";
import type { InkPoint } from "@reader/shared/whiteboard/model";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });

/** 母轮廓由直边与四段真实圆弧生成，检查相切与半径，不以平滑程度代替几何正确性。 */
function rounded(
  width: number,
  height: number,
  radius: number,
  rotation = 0,
  noise = 0,
): InkPoint[] {
  const halfWidth = width / 2,
    halfHeight = height / 2,
    points: InkPoint[] = [];
  const corners = [
    [halfWidth - radius, -halfHeight + radius, -Math.PI / 2],
    [halfWidth - radius, halfHeight - radius, 0],
    [-halfWidth + radius, halfHeight - radius, Math.PI / 2],
    [-halfWidth + radius, -halfHeight + radius, Math.PI],
  ];
  for (let i = 0; i < 4; i++) {
    const [cx, cy, start] = corners[i]!;
    const arc = Array.from({ length: 33 }, (_, j) =>
      p(
        cx! + radius * Math.cos(start! + (j * Math.PI) / 64),
        cy! + radius * Math.sin(start! + (j * Math.PI) / 64),
      ),
    );
    points.push(...arc);
    const [nx, ny, next] = corners[(i + 1) % 4]!,
      a = arc.at(-1)!,
      b = p(nx! + radius * Math.cos(next!), ny! + radius * Math.sin(next!));
    for (let j = 1; j <= 32; j++)
      points.push(p(a.x + ((b.x - a.x) * j) / 32, a.y + ((b.y - a.y) * j) / 32));
  }
  return points.map((point, i) => {
    const x = point.x + noise * Math.sin(i * 1.7),
      y = point.y + noise * Math.sin(i * 2.1);
    return p(
      500 + x * Math.cos(rotation) - y * Math.sin(rotation),
      300 + x * Math.sin(rotation) + y * Math.cos(rotation),
    );
  });
}

describe("直边与圆弧的联合拟合", () => {
  it.each([0, 0.47, 1.2])("圆角矩形恢复统一圆角与四条相切直边 %s", (rotation) => {
    const source = rounded(260, 160, 35, rotation, 1),
      result = repairShape(source, 1);
    expect(result?.label).toBe("rounded-rectangle");
    expect(result!.points[0]).toEqual(result!.points.at(-1));
    expect(contourDeviation(rounded(260, 160, 35, rotation), result!.points)!.rms).toBeLessThan(
      1.2,
    );
    const local = result!.points.map((point) =>
      p(
        (point.x - 500) * Math.cos(rotation) + (point.y - 300) * Math.sin(rotation),
        -(point.x - 500) * Math.sin(rotation) + (point.y - 300) * Math.cos(rotation),
      ),
    );
    const corners = local.filter((point) => Math.abs(point.x) > 95 && Math.abs(point.y) > 45);
    const radii = corners.map((point) =>
      Math.hypot(Math.abs(point.x) - 95, Math.abs(point.y) - 45),
    );
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1.5);
  });

  it.each([0, 0.7])("胶囊恢复两个等半径半圆和两条平行相切直边 %s", (rotation) => {
    const source = rounded(300, 100, 50, rotation, 0.6),
      result = repairShape(source, 1);
    expect(result?.label).toBe("capsule");
    expect(result!.points[0]).toEqual(result!.points.at(-1));
    expect(contourDeviation(rounded(300, 100, 50, rotation), result!.points)!.rms).toBeLessThan(1);
  });

  it("明确椭圆、尖角矩形和重复描画不能被圆角族吞掉", () => {
    const ellipse = Array.from({ length: 193 }, (_, i) =>
      p(
        500 + 130 * Math.cos((i * 2 * Math.PI) / 192),
        300 + 50 * Math.sin((i * 2 * Math.PI) / 192),
      ),
    );
    expect(repairShape(ellipse, 1)?.label).toBe("ellipse");
    expect(repairShape(rounded(260, 160, 0), 1)?.label).toBe("rectangle");
    const source = rounded(260, 160, 35);
    expect(repairShape([...source, ...source.slice(1)], 1)).toBeNull();
  });

  it("可见开口的圆角轮廓保留开口，不能凭闭合族补缺失边", () => {
    const source = rounded(260, 160, 35).slice(0, 210),
      result = repairShape(source, 1);
    expect(result?.label).not.toBe("rounded-rectangle");
    expect(result?.label).not.toBe("capsule");
  });
});
