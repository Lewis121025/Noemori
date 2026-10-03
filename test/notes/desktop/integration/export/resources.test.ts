import { computeExport } from "@reader/main/export/computation";
import { describe, expect, it, vi } from "vitest";
import { decodeImageData, ExportResources } from "@reader/main/export/resources";
import type { ExportRenderer } from "@reader/main/export/render";
import { nativeExportFixture } from "../../support/export-native";
import { BOARD_COORDINATE_LIMIT } from "@reader/shared/whiteboard/model";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=";
const bytes = new TextEncoder().encode(svg);
const renderer = (): ExportRenderer => ({
  render: vi.fn<ExportRenderer["render"]>(async (request) => {
    if (request.kind === "image")
      return { kind: "image", data: request.source, width: 1, height: 1 };
    if (request.kind === "raster") return { kind: "image", data: png, width: 1, height: 1 };
    return { kind: "ready" };
  }),
  pdf: async () => {
    throw new Error("不应打印");
  },
});

describe("EXP-RESOURCES 冻结资源与转换结果", () => {
  it("最大合法世界坐标的白板可以作为矢量资源嵌入，viewBox 保留完整笔迹", async (t) => {
    const limit = BOARD_COORDINATE_LIMIT;
    const source = JSON.stringify({
      version: 1,
      strokes: [
        {
          id: "full",
          width: 100,
          points: [
            { x: -limit, y: -limit, pressure: 1 },
            { x: limit, y: limit, pressure: 1 },
          ],
        },
      ],
    });
    const fixture = await nativeExportFixture(t, { "large.noemoriboard": source }, "markdown", [
      "large.noemoriboard",
    ]);
    const resources = new ExportResources(
      fixture.native,
      renderer(),
      new AbortController().signal,
      computeExport,
    );
    const image = await resources.board("large.noemoriboard");
    const data = decodeImageData(await resources.imageData(image.path));
    expect(data.mime).toBe("image/svg+xml");
    const svg = new TextDecoder().decode(data.bytes);
    expect(svg).toContain('viewBox="-10000074 -10000074 20000148 20000148"');
    expect(svg).toContain('stroke-width="100"');
    expect(svg).toContain("-10000000");
    expect(svg).toContain("10000000");
  });
  it("Word 的远程 SVG 保留原始副本并使用冻结 PNG，重复访问不重复下载或生成", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      { "a.md": "正文", "attachment.bin": "payload" },
      "docx",
    );
    const fetch = vi.fn(
      async () => new Response(svg, { headers: { "content-type": "image/svg+xml" } }),
    );
    vi.stubGlobal("fetch", fetch);
    t.onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const render = renderer();
    const resources = new ExportResources(
      fixture.native,
      render,
      new AbortController().signal,
      computeExport,
    );
    const url = "https://images.test/original.svg";
    const first = await resources.image(url, true);
    expect(first.mime).toBe("image/png");
    expect(await resources.image(url, true)).toBe(first);
    expect(await resources.imageData(first.path)).toBe(png);
    expect(resources.downloads).toHaveLength(1);
    expect(resources.downloads[0]?.path).toMatch(/\.svg$/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(render.render).toHaveBeenCalledTimes(2);
    const attachment = await resources.attachment("attachment.bin");
    expect(await resources.attachment("attachment.bin")).toBe(attachment);
    await fixture.native.seal();
    expect(fixture.native.snapshot.resources).toBe(1);
    expect(fixture.native.snapshot.resourceBytes).toBe(bytes.byteLength);
  });

  it("错误的渲染回复、超预算尺寸和未登记图片全部拒绝", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      { "a.md": "正文", "preview.pdf": "%PDF-test" },
      "markdown",
    );
    const render = renderer();
    const resources = new ExportResources(
      fixture.native,
      render,
      new AbortController().signal,
      computeExport,
    );
    await expect(resources.imageData("unknown")).rejects.toThrow("不属于");
    await expect(resources.stageImage(bytes, "application/pdf")).rejects.toThrow("不是");
    vi.mocked(render.render).mockResolvedValueOnce({ kind: "ready" });
    await expect(resources.stageImage(bytes, "image/svg+xml")).rejects.toThrow("尺寸");
    vi.mocked(render.render).mockResolvedValueOnce({
      kind: "image",
      data: png,
      width: 16385,
      height: 1,
    });
    await expect(resources.stageImage(bytes, "image/svg+xml")).rejects.toThrow("预算");
    await expect(resources.diagram("invalid")).rejects.toThrow("SVG");
    await expect(resources.pdf("preview.pdf", 1)).rejects.toThrow("预览");
  });

  it("转换器返回损坏的图片字节时不得将它登记为有效资源", async (t) => {
    const fixture = await nativeExportFixture(t, { "a.md": "正文" }, "markdown");
    const render = renderer();
    vi.mocked(render.render).mockResolvedValue({
      kind: "image",
      data: "data:image/png;base64,AQID",
      width: 1,
      height: 1,
    });
    const resources = new ExportResources(
      fixture.native,
      render,
      new AbortController().signal,
      computeExport,
    );
    await expect(resources.stageImage(bytes, "image/svg+xml", true)).rejects.toThrow();
    expect(resources.images.size).toBe(0);
  });

  it("data URL 的百分号编码保留字节，非法格式或非法 Base64 不得被静默修复", () => {
    expect(decodeImageData(`data:image/svg+xml,${encodeURIComponent(svg)}`)).toEqual({
      bytes: Buffer.from(svg),
      mime: "image/svg+xml",
    });
    expect(decodeImageData("data:image/png;base64,AQI").bytes).toEqual(Buffer.from([1, 2]));
    expect(decodeImageData("data:image/png;base64,AQ I%3D").bytes).toEqual(Buffer.from([1, 2]));
    for (const source of [
      "https://example.test/a.png",
      "data:text/html,content",
      "data:image/png;base64,AQ!ID",
      "data:image/png;base64,A",
      "data:image/png;base64,AQI==",
      "data:image/png;base64,",
      "data:image/png;base64, ",
    ])
      expect(() => decodeImageData(source)).toThrow();
  });
});
