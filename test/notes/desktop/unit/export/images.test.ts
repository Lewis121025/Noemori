import { describe, expect, it } from "vitest";
import { checkExportImage } from "@reader/shared/export-image";
import { EXPORT_LIMITS } from "@reader/shared/export";
import { whiteboardSvg } from "@reader/main/export/resources";

const svg = (width: number, height: number) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`,
  );

describe("解码前的图片预算和完整白板范围", () => {
  it("本地图片按实际像素预算验收，不套用网络下载的 64 MiB 限额", () => {
    const width = 6000;
    const height = 4000;
    const bytes = new Uint8Array(54 + width * height * 3);
    const header = new DataView(bytes.buffer);
    header.setUint16(0, 0x4d42, true);
    header.setUint32(2, bytes.length, true);
    header.setUint32(10, 54, true);
    header.setUint32(14, 40, true);
    header.setInt32(18, width, true);
    header.setInt32(22, height, true);
    header.setUint16(26, 1, true);
    header.setUint16(28, 24, true);
    header.setUint32(34, width * height * 3, true);
    expect(bytes.byteLength).toBeGreaterThan(EXPORT_LIMITS.resourceBytes);
    expect(() => checkExportImage(bytes, "image/bmp")).not.toThrow();
  });
  it("分别覆盖最大边和像素预算的边界两侧", () => {
    expect(() => checkExportImage(svg(EXPORT_LIMITS.imageEdge, 1), "image/svg+xml")).not.toThrow();
    expect(() => checkExportImage(svg(EXPORT_LIMITS.imageEdge + 1, 1), "image/svg+xml")).toThrow(
      "解码尺寸",
    );
    expect(() => checkExportImage(svg(8192, 4096), "image/svg+xml")).not.toThrow();
    expect(() => checkExportImage(svg(8192, 4097), "image/svg+xml")).toThrow("解码尺寸");
    expect(() => checkExportImage(svg(0, 1), "image/svg+xml")).toThrow();
    expect(() => checkExportImage(svg(100, 100), "image/png")).toThrow("类型声明");
    expect(() => checkExportImage(new Uint8Array([1, 2, 3]), "image/png")).toThrow();
  });
  it("空白板固定尺寸，负坐标和粗笔宽包含在 SVG 边界内", () => {
    expect(whiteboardSvg('{"version":1,"strokes":[]}')).toContain('viewBox="0 0 640 300"');
    const image = whiteboardSvg(
      JSON.stringify({
        version: 1,
        strokes: [{ id: "point", width: 20, points: [{ x: -100, y: -200, pressure: 1 }] }],
      }),
    );
    expect(image).toContain('viewBox="-134 -234 68 68"');
    expect(image).not.toContain("var(");
  });
});
