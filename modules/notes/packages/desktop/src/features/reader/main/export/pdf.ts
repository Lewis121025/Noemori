import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFRef,
  PDFString,
} from "@cantoo/pdf-lib";

/** PDF 的链接清单来自已解析的正文；目标名称仅限本次全局锚点表。 */
export type PdfExportLinks = { links: readonly string[]; destinations: readonly string[] };

function text(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString)
    return value.decodeText();
  return undefined;
}

/**
 * 独立解析打印结果，修正浏览器解析成宿主地址的包内链接并核验命名目标。
 * 目标探针只用于获得分页后的精确坐标，提交前删除其注解和临时名称。
 * @throws 损坏 PDF、未冻结的本机链接、目标缺失或取消时整批拒绝。
 */
export async function finalizeExportPdf(
  bytes: Uint8Array,
  pageUrl: string,
  options: PdfExportLinks,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  if (pdf.getPageCount() === 0) throw new Error("PDF 没有页面");
  const relative = new Map<string, string>();
  const remaining = new Set<string>();
  for (const link of options.links) {
    if (link.startsWith("#")) {
      remaining.add(link);
      continue;
    }
    if (/^(?:https?:|mailto:)/i.test(link)) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(link)) throw new Error("PDF 包内链接不是相对路径");
    const output = link.replace(/\.pdf#([a-zA-Z0-9_]+)$/, ".pdf#nameddest=$1");
    relative.set(new URL(link, pageUrl).href, output);
    remaining.add(link);
  }
  const destinations = pdf.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  const probes = new Set(options.destinations.map((id) => `noemori_probe_${id}`));
  let changed = false;
  const removed = new Set<PDFRef>();
  for (const id of options.destinations) {
    const probe = PDFName.of(`noemori_probe_${id}`);
    const location = destinations?.get(probe);
    if (!location || !destinations) throw new Error(`PDF 无法定位目标：${id}`);
    const name = PDFName.of(id);
    if (!destinations.has(name)) destinations.set(name, location);
    destinations.delete(probe);
    changed = true;
  }
  for (const page of pdf.getPages()) {
    signal.throwIfAborted();
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (let index = annotations.size() - 1; index >= 0; index--) {
      const annotation = annotations.lookup(index, PDFDict);
      const action = annotation.lookupMaybe(PDFName.of("A"), PDFDict);
      const target =
        text(annotation.lookup(PDFName.of("Dest"))) ?? text(action?.lookup(PDFName.of("D")));
      if (target && probes.has(target)) {
        if (annotation.has(PDFName.of("StructParent")))
          throw new Error("PDF 定位探针意外进入了正文结构");
        const reference = annotations.get(index);
        if (reference instanceof PDFRef) removed.add(reference);
        annotations.remove(index);
        changed = true;
        continue;
      }
      if (target) {
        if (!destinations?.has(PDFName.of(target)))
          throw new Error(`PDF 内部链接缺少目标：${target}`);
        remaining.delete(`#${target}`);
      }
      if (!action || text(action.lookup(PDFName.of("S"))) !== "URI") continue;
      const uri = text(action.lookup(PDFName.of("URI")));
      if (!uri) throw new Error("PDF 链接缺少有效地址");
      if (options.links.includes("#") && (uri === pageUrl || uri === `${pageUrl}#`)) {
        const firstPage = pdf.getPages()[0];
        if (!firstPage) throw new Error("PDF 没有首页");
        action.delete(PDFName.of("URI"));
        action.set(PDFName.of("S"), PDFName.of("GoTo"));
        action.set(
          PDFName.of("D"),
          pdf.context.obj([firstPage.ref, "FitH", firstPage.getHeight()]),
        );
        remaining.delete("#");
        changed = true;
        continue;
      }
      const replacement = relative.get(uri);
      if (replacement !== undefined) {
        // URI 使用 ASCII 字节的十六进制字符串，文件名中的括号不能破坏 PDF 语法。
        if (/[^\x20-\x7e]/.test(replacement)) throw new Error("PDF 链接尚未完成编码");
        action.set(
          PDFName.of("URI"),
          PDFHexString.of(Buffer.from(replacement, "ascii").toString("hex")),
        );
        for (const link of remaining)
          if (!link.startsWith("#") && new URL(link, pageUrl).href === uri) remaining.delete(link);
        changed = true;
      } else if (/^(?:file:|noemori-)/i.test(uri))
        throw new Error("PDF 保留了未冻结的宿主或内部地址");
    }
  }
  if (remaining.size) throw new Error(`PDF 缺少正文链接：${[...remaining].join("、")}`);
  for (const reference of removed) pdf.context.delete(reference);
  signal.throwIfAborted();
  if (!changed) return bytes;
  const result = await pdf.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
  signal.throwIfAborted();
  const verified = await PDFDocument.load(result, {
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
  if (verified.getPageCount() !== pdf.getPageCount()) throw new Error("PDF 修正链接后页数变化");
  return result;
}
