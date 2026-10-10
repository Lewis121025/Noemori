/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { previewDocument } from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/preview-document";
import { diagramPreview } from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/diagram-preview";

it("SVG 的 HTML 标签保留图中文字，同时去掉脚本、事件和跳转能力", () => {
  const html = previewDocument(
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)"><span>开始</span></div></foreignObject><a href="https://example.com" xlink:href="https://example.com"><text>结束</text></a><script>alert(1)</script></svg>',
  );
  const page = new DOMParser().parseFromString(html, "text/html");
  expect(page.querySelector("foreignObject")?.textContent).toBe("开始");
  expect(page.querySelector("svg")?.textContent).toContain("结束");
  expect(page.querySelector("script, [onclick], a[href]")).toBeNull();
  expect(page.querySelector("a")?.hasAttribute("xlink:href")).toBe(false);
  expect(
    page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  ).toContain("default-src 'none'");
});

it("图表按有效视框分配展示空间，缺失尺寸使用有限比例且不丢失标签", () => {
  const preview = diagramPreview('<svg viewBox="-20 10 600 200"><text>开始</text></svg>', false);
  expect(preview.aspectRatio).toBe(3);
  expect(preview.document).toContain("开始");
  for (const viewBox of ["", "0 0 0 0", "0 0 -1 100", "0 0 1e309 100", "0 0 100"])
    expect(diagramPreview(`<svg viewBox="${viewBox}"></svg>`, false).aspectRatio).toBe(4 / 3);
  expect(() => diagramPreview("没有图表", false)).toThrow("SVG");
});
