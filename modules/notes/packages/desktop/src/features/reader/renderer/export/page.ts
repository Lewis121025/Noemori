import { DOMSerializer, type DOMOutputSpec, type Node as PmNode } from "prosemirror-model";
import { documentSchema } from "../../shared/markdown/schema";
import type {
  ExportRenderReply,
  ExportRenderRequest,
  ExportAnchor,
} from "../../shared/export-render";
import { EXPORT_LIMITS } from "../../shared/export";
import { checkExportImage } from "../../shared/export-image";
import { parseExportHtml, parseInlineExportHtml } from "./html";
import { validateExportSvg, sanitizeExportDiagram } from "./svg";
import "../styles/content.css";
import "./print.css";

declare global {
  interface Window {
    /** 隔离页面的唯一宿主入口；请求经结构化 JSON 传入，拒绝不受支持的内容。 */
    noemoriExport: (request: ExportRenderRequest) => Promise<ExportRenderReply>;
  }
}

function host(): HTMLElement {
  const element = document.getElementById("content");
  if (!element) throw new Error("导出页面尚未准备好");
  return element;
}

function assertPixels(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > EXPORT_LIMITS.imageEdge ||
    height > EXPORT_LIMITS.imageEdge ||
    width * height > EXPORT_LIMITS.imagePixels
  )
    throw new Error("图片尺寸超过导出预算，请缩小图片或使用 SVG");
}

async function readImage(source: string): Promise<HTMLImageElement> {
  if (!source.startsWith("data:image/")) throw new Error("导出页面只接受已冻结的图片");
  const encoded = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]*)$/i.exec(source);
  if (!encoded?.[1] || !encoded[2]) throw new Error("导出图片数据格式无效");
  checkExportImage(
    Uint8Array.from(atob(encoded[2]), (char) => char.charCodeAt(0)),
    encoded[1],
  );
  if (source.startsWith("data:image/svg+xml;base64,")) {
    const raw = atob(source.slice("data:image/svg+xml;base64,".length));
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(raw, (char) => char.charCodeAt(0)),
    );
    await validateExportSvg(svg, readImage);
  }
  const image = new Image();
  image.src = source;
  await image.decode();
  assertPixels(image.naturalWidth, image.naturalHeight);
  return image;
}

function canvasImage(image: CanvasImageSource, width: number, height: number): ExportRenderReply {
  assertPixels(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建导出画布");
  try {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      kind: "image",
      data: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

async function renderDocument(
  value: unknown,
  anchors: ExportAnchor[],
  destinations: readonly string[],
): Promise<ExportRenderReply> {
  const doc = documentSchema.nodeFromJSON(value);
  doc.check();
  const nodes = DOMSerializer.nodesFromSchema(documentSchema);
  nodes.image = (node: PmNode): DOMOutputSpec => [
    "img",
    { src: String(node.attrs["src"]), alt: String(node.attrs["alt"] ?? "") },
  ];
  nodes.list_item = (node: PmNode): DOMOutputSpec => [
    "li",
    node.attrs["checked"] === null ? {} : { "data-checked": String(node.attrs["checked"]) },
    0,
  ];
  const identities = new WeakMap<PmNode, string>();
  for (const anchor of anchors) {
    const node = doc.nodeAt(anchor.position);
    if (!node || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(anchor.id)) throw new Error("导出锚点无效");
    identities.set(node, anchor.id);
  }
  for (const [name, serialize] of Object.entries(nodes))
    nodes[name] = (node) => {
      const output = serialize(node);
      const id = identities.get(node);
      if (!id) return output;
      const { dom, contentDOM } = DOMSerializer.renderSpec(document, output);
      if (!(dom instanceof HTMLElement)) throw new Error("导出锚点没有内容元素");
      dom.id = id;
      return contentDOM ? { dom, contentDOM } : { dom };
    };
  const content = host();
  content.replaceChildren(
    new DOMSerializer(nodes, DOMSerializer.marksFromSchema(documentSchema)).serializeFragment(
      doc.content,
    ),
  );
  for (const id of destinations) {
    const target = content.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target || !anchors.some((anchor) => anchor.id === id))
      throw new Error("PDF 跨文档目标不存在");
    const name = `noemori_probe_${id}`;
    const marker = document.createElement("span");
    marker.id = name;
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText = "position:absolute;display:block;width:0;height:0";
    target.prepend(marker);
    const probe = document.createElement("a");
    probe.href = `#${name}`;
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;left:0;top:0;display:block;width:1px;height:1px";
    content.append(probe);
  }
  for (const element of Array.from(content.querySelectorAll<HTMLElement>("[data-footnote-def]"))) {
    const marker = document.createElement("span");
    marker.id = `footnote-${element.dataset.footnoteDef ?? ""}`;
    marker.style.cssText = "position:absolute;display:block;width:0;height:0";
    element.prepend(marker);
  }
  for (const element of Array.from(content.querySelectorAll<HTMLElement>("[data-footnote-ref]"))) {
    const link = document.createElement("a");
    link.href = `#footnote-${element.dataset.footnoteRef ?? ""}`;
    link.textContent = element.textContent;
    element.replaceChildren(link);
  }
  const formulas = Array.from(content.querySelectorAll<HTMLElement>("[data-math-tex]"));
  const math = formulas.length
    ? (await import("../markdown/views/mathjax-engine")).createMathJaxEngine(true)
    : null;
  for (const element of formulas) {
    if (!math) throw new Error("公式引擎未初始化");
    const rendered = await math.convert(
      element.dataset.mathTex ?? "",
      element.dataset.mathDisplay === "true",
    );
    if (
      rendered.matches(".math-error") ||
      rendered.querySelector("[data-mml-node='merror'],mjx-merror")
    )
      throw new Error(`公式无法排版：${element.dataset.mathTex ?? ""}`);
    element.replaceChildren(rendered);
  }
  for (const image of Array.from(content.querySelectorAll("img"))) {
    if (!image.src.startsWith("data:image/")) throw new Error("导出图片未完成本地化");
    await image.decode();
    assertPixels(image.naturalWidth, image.naturalHeight);
  }
  await document.fonts.ready;
  for (const element of Array.from(content.querySelectorAll<HTMLElement>("[data-math-tex]")))
    if (element.scrollWidth > content.clientWidth + 2)
      throw new Error("公式宽度超过打印区域，请调整公式布局");
  return { kind: "ready" };
}

window.noemoriExport = async (request) => {
  host().replaceChildren();
  switch (request.kind) {
    case "document":
      return renderDocument(request.doc, request.anchors, request.destinations ?? []);
    case "image": {
      const image = await readImage(request.source);
      return {
        kind: "image",
        data: request.source,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
    }
    case "raster": {
      const image = await readImage(request.source);
      if (!Number.isFinite(request.scale) || request.scale <= 0 || request.scale > 4)
        throw new Error("图片输出比例无效");
      return canvasImage(
        image,
        image.naturalWidth * request.scale,
        image.naturalHeight * request.scale,
      );
    }
    case "mermaid": {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        look: "classic",
        themeVariables: { useGradient: false },
        htmlLabels: false,
        secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "htmlLabels"],
        suppressErrorRendering: true,
      });
      const { svg } = await mermaid.render("export-diagram", request.source);
      const safe = await sanitizeExportDiagram(svg, readImage);
      return { kind: "svg", svg: safe };
    }
    case "html": {
      return { kind: "html", doc: parseExportHtml(request.source).toJSON() };
    }
    case "inlineHtml": {
      const parent = documentSchema.nodeFromJSON(request.parent);
      return { kind: "html", doc: parseInlineExportHtml(parent).toJSON() };
    }
    case "pdf": {
      const { openPdf } = await import("../preview/pdf");
      let denyPassword: (reason: Error) => void = () => {};
      const password = new Promise<never>((_resolve, reject) => {
        denyPassword = reject;
      });
      const task = openPdf(new Uint8Array(request.bytes), () =>
        denyPassword(new Error("加密 PDF 附件需要先解密再导出")),
      );
      try {
        const pdf = await Promise.race([task.promise, password]);
        if (!Number.isInteger(request.page) || request.page < 1 || request.page > pdf.numPages)
          throw new Error("PDF 附件页码无效");
        const page = await pdf.getPage(request.page);
        const viewport = page.getViewport({ scale: 2 });
        assertPixels(viewport.width, viewport.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        try {
          await page.render({ canvas, viewport }).promise;
          return {
            kind: "image",
            data: canvas.toDataURL("image/png"),
            width: canvas.width,
            height: canvas.height,
          };
        } finally {
          canvas.width = canvas.height = 0;
        }
      } finally {
        await task.destroy();
      }
    }
  }
};
