import { previewDocument } from "./preview-document";

/** 图表的隔离文档及宽高比；比例只决定展示空间，不改写节点或图中文字。 */
export type DiagramPreview = { document: string; aspectRatio: number };

/**
 * 保留 SVG 视框比例，让不同方向的图表在受限消息宽度内居中显示。
 * @param svg Mermaid 引擎生成的 SVG，先执行共用清理再补入宿主布局规则。
 * @param dark 与宿主一致的配色模式，避免深色界面中的 iframe 被浏览器铺成白底。
 * @returns 隔离文档和正数宽高比；缺少有效视框的 SVG 使用 4:3 展示空间。
 * @throws 内容不含根 SVG 时抛错，由预览显示可展开的错误详情。
 */
export function diagramPreview(svg: string, dark: boolean): DiagramPreview {
  const page = new DOMParser().parseFromString(previewDocument(svg), "text/html");
  page.documentElement.style.colorScheme = dark ? "dark" : "light";
  const diagram = page.querySelector("body > svg");
  if (!diagram) throw new Error("图表没有生成 SVG");
  const bounds = diagram
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  const width = bounds?.[2] ?? 0,
    height = bounds?.[3] ?? 0;
  const ratio = width / height;
  const aspectRatio =
    bounds?.length === 4 && width > 0 && height > 0 && Number.isFinite(ratio) ? ratio : 4 / 3;
  const style = page.createElement("style");
  style.textContent =
    "html,body{margin:0;width:100%;height:100%;overflow:hidden}body{box-sizing:border-box;padding:24px;display:grid;place-items:center}body>svg{display:block;width:100%;height:100%}";
  page.head.append(style);
  return { document: "<!doctype html>" + page.documentElement.outerHTML, aspectRatio };
}
