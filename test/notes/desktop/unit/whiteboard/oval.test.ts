import { describe, expect, it } from "vitest";
import { fitShape } from "@reader/shared/whiteboard/fitting";
import type { InkPoint } from "@reader/shared/whiteboard/model";
import { parseShapePrediction } from "@reader/shared/whiteboard/recognition";

function contour(ratio: number, rotation = 0, scale = 1): InkPoint[] {
  return Array.from({ length: 193 }, (_, i) => {
    const angle = (i * 2 * Math.PI) / 192;
    const noise = i === 0 || i === 192 ? 0 : Math.sin(i * 2.3) * 0.4;
    const x = 100 * Math.cos(angle) + noise;
    const y = 100 * ratio * Math.sin(angle) + noise;
    return {
      x: (600 + x * Math.cos(rotation) - y * Math.sin(rotation)) / scale,
      y: (-300 + x * Math.sin(rotation) + y * Math.cos(rotation)) / scale,
      pressure: 0.5,
    };
  });
}

describe("闭合圆与椭圆的共享拟合族", () => {
  it("圆椭圆概率分散时以真实族概率准入", () => {
    expect(
      fitShape(
        contour(0.72),
        { label: "ellipse", confidence: 0.49, oval: { circle: 0.48, ellipse: 0.49 } },
        1,
      )?.label,
    ).toBe("ellipse");
  });
  it("不能把族概率不足的输入靠同族分数提升变成圆", () => {
    expect(
      fitShape(
        contour(1),
        {
          label: "circle",
          confidence: 0.4678,
          oval: { circle: 0.4678, ellipse: 0.0008 },
          refinement: { label: "circle", confidence: 0.9, oval: { circle: 0.9, ellipse: 0.001 } },
        },
        1,
      ),
    ).toBeNull();
  });
  it("缺少真实子类型概率时保留原分类，跨进程拒绝伪造或不一致的子类型概率", () => {
    expect(fitShape(contour(0.72), { label: "circle", confidence: 0.8 }, 1)).toBeNull();
    for (const oval of [
      { circle: 0.8, ellipse: 0.4 },
      { circle: NaN, ellipse: 0.2 },
      { circle: 0.7, ellipse: 0.2 },
      { circle: 0.8, ellipse: -0.1 },
    ])
      expect(() => parseShapePrediction({ label: "circle", confidence: 0.8, oval })).toThrow();
    expect(
      parseShapePrediction({
        label: "circle",
        confidence: 0.8,
        oval: { circle: 0.8, ellipse: 0.15 },
      }),
    ).toEqual({ label: "circle", confidence: 0.8, oval: { circle: 0.8, ellipse: 0.15 } });
  });
  it.each([0, 0.43, 1.2])("模型偏向圆时仍应保留清晰椭圆的整体长短轴 %s", (rotation) => {
    const result = fitShape(
      contour(0.72, rotation),
      {
        label: "circle",
        confidence: 0.8,
        oval: { circle: 0.8, ellipse: 0.2 },
        refinement: { label: "ellipse", confidence: 0.8, oval: { circle: 0.2, ellipse: 0.8 } },
      },
      1,
    );
    expect(result).not.toBeNull();
    expect(result?.label).toBe("ellipse");
    const radii = result!.points.map((p) => Math.hypot(p.x - 600, p.y + 300));
    expect(Math.max(...radii)).toBeCloseTo(100, 0);
    expect(Math.min(...radii)).toBeCloseTo(72, 0);
  });

  it.each([0.5, 1, 2])("模型偏向椭圆时，圆应恢复恒定半径且缩放不改变最终类别 %s", (scale) => {
    const result = fitShape(
      contour(1, 0.4, scale),
      {
        label: "ellipse",
        confidence: 0.8,
        oval: { circle: 0.2, ellipse: 0.8 },
        refinement: { label: "circle", confidence: 0.8, oval: { circle: 0.8, ellipse: 0.2 } },
      },
      scale,
    );
    expect(result?.label).toBe("circle");
    const radii = result!.points.map((p) => Math.hypot(p.x - 600 / scale, p.y + 300 / scale));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.1 / scale);
  });

  it("可以正确拟合的圆保留圆型，不把轻微变形一律改成椭圆", () => {
    const result = fitShape(
      contour(0.94, 0.6),
      { label: "circle", confidence: 0.65, oval: { circle: 0.65, ellipse: 0.35 } },
      1,
    );
    expect(result?.label).toBe("circle");
    const radii = result!.points.map((p) => Math.hypot(p.x - 600, p.y + 300));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.1);
  });

  it("几何拟合不能推翻几乎被模型排除的子类型", () => {
    expect(
      fitShape(
        contour(0.72),
        { label: "circle", confidence: 0.99, oval: { circle: 0.99, ellipse: 0.01 } },
        1,
      ),
    ).toBeNull();
  });

  it("椭圆已通过完整几何校验时，不能被无法通过校验的圆候选阻断", () => {
    const points = Array.from({ length: 193 }, (_, i) => {
      const angle = (i * 2 * Math.PI) / 192;
      const noise = i === 0 || i === 192 ? 0 : 14 * Math.sin(i * 1.73);
      return {
        x: (100 + noise) * Math.cos(angle),
        y: (92 + noise) * Math.sin(angle),
        pressure: 0.5,
      };
    });
    expect(fitShape(points, { label: "ellipse", confidence: 0.8 }, 0.3)?.label).toBe("ellipse");
    expect(
      fitShape(
        points,
        { label: "ellipse", confidence: 0.8, oval: { circle: 0.2, ellipse: 0.8 } },
        0.3,
      )?.label,
    ).toBe("ellipse");
  });

  it("共享拟合族仍拒绝半圈、重复整圈、额外笔画和低置信度", () => {
    const points = contour(0.72);
    const prediction = { label: "circle", confidence: 0.8 } as const;
    expect(fitShape(points.slice(0, 97), prediction, 1)).toBeNull();
    expect(fitShape([...points, ...points.slice(1)], prediction, 1)).toBeNull();
    expect(
      fitShape([...points, { x: 600, y: -300, pressure: 0.5 }, points[0]!], prediction, 1),
    ).toBeNull();
    expect(fitShape(points, { label: "circle", confidence: 0.49 }, 1)).toBeNull();
    expect(fitShape(points, { label: "other", confidence: 1 }, 1)).toBeNull();
  });

  it("原候选有效时保持完整坐标，改进候选只补充原来无法拟合的图形", () => {
    const points = contour(0.72);
    const primary = { label: "ellipse", confidence: 0.8 } as const;
    const original = fitShape(points, primary, 1);
    expect(
      fitShape(points, { ...primary, refinement: { label: "other", confidence: 1 } }, 1),
    ).toEqual(original);
    expect(
      fitShape(points, { label: "line", confidence: 0.8, refinement: primary }, 1)?.label,
    ).toBe("ellipse");
    expect(
      fitShape(
        points,
        { label: "other", confidence: 1, refinement: { ...primary, confidence: 0.49 } },
        1,
      ),
    ).toBeNull();
    expect(
      fitShape(points.slice(0, 97), { label: "other", confidence: 1, refinement: primary }, 1),
    ).toBeNull();
  });

  it("跨进程验证改进候选的真实概率，拒绝非法分数和递归嵌套", () => {
    const prediction = {
      label: "other",
      confidence: 0.8,
      refinement: { label: "ellipse", confidence: 0.7, oval: { circle: 0.2, ellipse: 0.7 } },
    };
    expect(parseShapePrediction(prediction)).toEqual(prediction);
    expect(() =>
      parseShapePrediction({ ...prediction, refinement: { label: "ellipse", confidence: NaN } }),
    ).toThrow();
    expect(() =>
      parseShapePrediction({
        ...prediction,
        refinement: { ...prediction.refinement, refinement: prediction.refinement },
      }),
    ).toThrow();
  });

  it("已识别的圆椭圆族只接受原子类型证据；改进头不能改名绕过原来的拒绝", () => {
    const refinement = {
      label: "ellipse",
      confidence: 0.9,
      oval: { circle: 0.05, ellipse: 0.9 },
    } as const;
    expect(
      fitShape(
        contour(0.72),
        { label: "circle", confidence: 0.99, oval: { circle: 0.99, ellipse: 0.01 }, refinement },
        1,
      ),
    ).toBeNull();
    expect(
      fitShape(
        contour(0.72),
        { label: "circle", confidence: 0.49, oval: { circle: 0.49, ellipse: 0.48 }, refinement },
        1,
      )?.label,
    ).toBe("ellipse");
  });

  it("族内合计概率不能接受两个头都未选中的新增子类型", () => {
    expect(
      fitShape(
        contour(0.72),
        {
          label: "circle",
          confidence: 0.49,
          oval: { circle: 0.49, ellipse: 0.48 },
          refinement: { label: "circle", confidence: 0.8, oval: { circle: 0.8, ellipse: 0.2 } },
        },
        1,
      ),
    ).toBeNull();
  });
});
