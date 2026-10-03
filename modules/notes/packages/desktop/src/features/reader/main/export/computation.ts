import { isUint8Array } from "node:util/types";
import type { Node as PmNode } from "prosemirror-model";
import { documentSchema } from "../../shared/markdown/schema";
import { isEntryPath } from "../../shared/file-browser";
import { EXPORT_LIMITS } from "../../shared/export";
import type { ExportAnchor } from "../../shared/export-render";
import { portableMarkdown, type PreparedExportDocument } from "./documents";
import { compileExportMath, expectedExportFormulas, type FormulaExpectation } from "./math";
import { toPandoc } from "./pandoc-document";
import type { ExportImageSize } from "./pandoc-document";
import { validateDocx } from "./docx-validation";
import { finalizeExportPdf, type PdfExportLinks } from "./pdf";
import { whiteboardSvg, exportResourceHash } from "./resources";

/** 跨线程文档只携带当前转换阶段需要的正文、锚点和公式来源。 */
export type SerializedExportDocument = {
  path: string;
  output: string;
  doc: unknown;
  anchors: ExportAnchor[];
  formulas: { position: number; path: string; line: number }[];
};

/** 仅导出所需的固定计算动作；不接受插件、任意代码或宿主文件读写。 */
export type ExportComputationRequest =
  | { kind: "checkMath" | "markdown"; document: SerializedExportDocument }
  | { kind: "whiteboard"; bytes: Uint8Array; layout: "native" | "document" }
  | {
      kind: "prepareDocx";
      document: SerializedExportDocument;
      directory: string;
      images: ({ path: string } & ExportImageSize)[];
    }
  | { kind: "validateDocx"; bytes: Uint8Array; expected: FormulaExpectation[]; media: string[] }
  | { kind: "finalizePdf"; bytes: Uint8Array; pageUrl: string; links: PdfExportLinks };
/** 工作线程边界必须校验返回值，未知回复不能当成通过。 */
export type ExportComputation = (request: ExportComputationRequest) => Promise<unknown>;
/** Pandoc 输入与独立期望值分别产生；子进程仍由宿主管理和取消。 */
export type PreparedDocx = { input: string; expected: FormulaExpectation[]; media: string[] };

/** 将公式节点身份转换成文档位置，避免线程复制丢失 Map 的对象身份。 */
export function packExportDocument(document: PreparedExportDocument): SerializedExportDocument {
  const formulas: SerializedExportDocument["formulas"] = [];
  document.doc.descendants((node, position) => {
    const origin = document.formulaLocations.get(node);
    if (origin) formulas.push({ position, ...origin });
  });
  return {
    path: document.path,
    output: document.output,
    doc: document.doc.toJSON(),
    anchors: document.anchors,
    formulas,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function unpackDocument(value: unknown): PreparedExportDocument {
  if (
    !object(value) ||
    !isEntryPath(value.path) ||
    !isEntryPath(value.output) ||
    !Array.isArray(value.formulas) ||
    !Array.isArray(value.anchors)
  )
    throw new Error("导出计算文档无效");
  const doc = documentSchema.nodeFromJSON(value.doc);
  doc.check();
  if (doc.type !== documentSchema.topNodeType) throw new Error("导出计算正文根无效");
  const anchors: ExportAnchor[] = value.anchors.map((anchor: unknown) => {
    if (
      !object(anchor) ||
      typeof anchor.position !== "number" ||
      !Number.isSafeInteger(anchor.position) ||
      anchor.position < 0 ||
      typeof anchor.id !== "string" ||
      !/^[a-zA-Z0-9_]+$/.test(anchor.id)
    )
      throw new Error("导出计算锚点无效");
    return { position: anchor.position, id: anchor.id };
  });
  const formulaLocations = new Map<PmNode, { path: string; line: number }>();
  for (const entry of value.formulas) {
    if (
      !object(entry) ||
      typeof entry.position !== "number" ||
      !Number.isSafeInteger(entry.position) ||
      entry.position < 0 ||
      !isEntryPath(entry.path) ||
      typeof entry.line !== "number" ||
      !Number.isSafeInteger(entry.line) ||
      entry.line < 1
    )
      throw new Error("导出计算公式来源无效");
    const node = doc.nodeAt(entry.position);
    if (
      !node ||
      !["math_inline", "math_block"].includes(node.type.name) ||
      formulaLocations.has(node)
    )
      throw new Error("导出计算公式来源缺失或重复");
    formulaLocations.set(node, { path: entry.path, line: entry.line });
  }
  return {
    path: value.path,
    output: value.output,
    doc,
    anchors,
    formulaLocations,
    locations: new Map(),
  };
}

function expectations(value: unknown): FormulaExpectation[] {
  if (!Array.isArray(value)) throw new Error("导出公式验收清单无效");
  return value.map((formula: unknown) => {
    if (
      !object(formula) ||
      typeof formula.mathml !== "string" ||
      !formula.mathml ||
      typeof formula.display !== "boolean" ||
      !object(formula.location) ||
      !isEntryPath(formula.location.path) ||
      (formula.location.line !== null &&
        (typeof formula.location.line !== "number" ||
          !Number.isSafeInteger(formula.location.line) ||
          formula.location.line < 1))
    )
      throw new Error("导出公式验收来源无效");
    return {
      mathml: formula.mathml,
      display: formula.display,
      location: { path: formula.location.path, line: formula.location.line },
    };
  });
}

/** 严格检查工作线程准备结果，防止缺少公式期望或媒体清单时绕过验收。 */
export function parsePreparedDocx(value: unknown): PreparedDocx {
  if (
    !object(value) ||
    typeof value.input !== "string" ||
    !value.input ||
    !strings(value.media) ||
    !value.media.every((hash) => /^[a-f0-9]{64}$/.test(hash)) ||
    new Set(value.media).size !== value.media.length
  )
    throw new Error("DOCX 准备响应无效");
  return { input: value.input, expected: expectations(value.expected), media: value.media };
}

/**
 * 纯计算入口运行于任务线程；每次动作独立建立数学上下文，不持有下一篇内容。
 * @throws 协议错误、内容错误及产物损坏原样传播，公式错误保留中文来源诊断。
 */
export async function computeExport(request: unknown): Promise<unknown> {
  if (!object(request)) throw new Error("导出计算请求无效");
  if (
    request.kind === "checkMath" ||
    request.kind === "markdown" ||
    request.kind === "prepareDocx"
  ) {
    const document = unpackDocument(request.document);
    if (request.kind === "markdown") return new TextEncoder().encode(portableMarkdown(document));
    const compiled = compileExportMath(document);
    if (request.kind === "checkMath") return null;
    if (typeof request.directory !== "string") throw new Error("DOCX 资源目录无效");
    const expected = expectedExportFormulas(document, compiled).map(
      ({ mathml, display, location }) => ({ mathml, display, location }),
    );
    const expanded = new Map(compiled.map((formula) => [formula.node, formula.tex]));
    if (!Array.isArray(request.images)) throw new Error("DOCX 图片尺寸清单无效");
    const images = new Map<string, ExportImageSize>();
    for (const image of request.images) {
      if (
        !object(image) ||
        typeof image.path !== "string" ||
        !isEntryPath(image.path) ||
        typeof image.width !== "number" ||
        !Number.isFinite(image.width) ||
        image.width <= 0 ||
        typeof image.height !== "number" ||
        !Number.isFinite(image.height) ||
        image.height <= 0 ||
        image.width > EXPORT_LIMITS.imageEdge ||
        image.height > EXPORT_LIMITS.imageEdge ||
        image.width * image.height > EXPORT_LIMITS.imagePixels ||
        images.has(image.path)
      )
        throw new Error("DOCX 图片显示尺寸无效");
      images.set(image.path, { width: image.width, height: image.height });
    }
    const input = JSON.stringify(toPandoc(document, request.directory, expanded, images).value);
    const media = new Set<string>();
    document.doc.descendants((node) => {
      if (node.type.name !== "image") return;
      media.add(exportResourceHash(String(node.attrs["src"])));
    });
    return { input, expected, media: [...media] };
  }
  if (!isUint8Array(request.bytes)) throw new Error("导出计算产物无效");
  if (
    request.kind === "whiteboard" &&
    (request.layout === "native" || request.layout === "document")
  )
    return new TextEncoder().encode(
      whiteboardSvg(
        new TextDecoder("utf-8", { fatal: true }).decode(request.bytes),
        request.layout,
      ),
    );
  if (request.kind === "validateDocx") {
    const expected = expectations(request.expected);
    if (!strings(request.media) || !request.media.every((hash) => /^[a-f0-9]{64}$/.test(hash)))
      throw new Error("DOCX 媒体验收清单无效");
    await validateDocx(request.bytes, expected.length, expected, new Set(request.media));
    return request.bytes;
  }
  if (
    request.kind === "finalizePdf" &&
    typeof request.pageUrl === "string" &&
    object(request.links) &&
    strings(request.links.links) &&
    strings(request.links.destinations)
  )
    return finalizeExportPdf(
      request.bytes,
      request.pageUrl,
      {
        links: request.links.links,
        destinations: request.links.destinations,
      },
      new AbortController().signal,
    );
  throw new Error("导出计算动作无效");
}
