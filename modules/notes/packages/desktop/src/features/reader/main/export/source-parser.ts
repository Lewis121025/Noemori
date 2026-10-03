import type { Nodes } from "mdast";
import type { Node as PmNode } from "prosemirror-model";
import { parseMarkdownDocument } from "../../shared/markdown/parse";
import { documentSchema } from "../../shared/markdown/schema";

/** 工作线程只交付可克隆的数据，节点对象和原文行号在宿主侧重新绑定。 */
export type SerializedExportSource = {
  doc: unknown;
  formulas: { position: number; line: number }[];
};
/** 解析能力与文件权限分离；宿主只传已冻结字节，取消或解析错误以异常传播。 */
export type ExportSourceParser = (bytes: Uint8Array) => Promise<unknown>;

/**
 * 从冻结 UTF-8 字节严格解析正文及公式源码位置；工作线程和纯逻辑测试共用此核心。
 * @throws 无效 UTF-8、语法树错误或公式和源码不对应时拒绝，不能返回空文档。
 */
export function parseExportSource(bytes: Uint8Array): SerializedExportSource {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(bytes)
    .replace(/^\uFEFF/, "");
  const { doc, tree } = parseMarkdownDocument(source);
  const originals: { source: string; line: number }[] = [];
  const collect = (node: Nodes): void => {
    if (node.type === "math" || node.type === "inlineMath") {
      if (!node.position) throw new Error("公式缺少源码位置");
      originals.push({ source: node.value, line: node.position.start.line });
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(tree);
  const formulas: SerializedExportSource["formulas"] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== "math_inline" && node.type.name !== "math_block") return;
    const original = originals[formulas.length];
    if (!original || original.source !== node.attrs["tex"])
      throw new Error("公式与源码位置无法对应");
    formulas.push({ position, line: original.line });
  });
  if (formulas.length !== originals.length) throw new Error("部分公式无法可靠转换");
  return { doc: doc.toJSON(), formulas };
}

/** 核验线程边界，不接受缺失、重复或不属于公式节点的源码标注。 */
export function unpackExportSource(value: unknown): { doc: PmNode; formulas: Map<PmNode, number> } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("doc" in value) ||
    !("formulas" in value) ||
    !Array.isArray(value.formulas)
  )
    throw new Error("导出解析回复无效");
  const doc = documentSchema.nodeFromJSON(value.doc);
  doc.check();
  if (doc.type !== documentSchema.topNodeType) throw new Error("导出解析文档根无效");
  const nodes = new Map<number, PmNode>();
  doc.descendants((node, position) => {
    if (node.type.name === "math_inline" || node.type.name === "math_block")
      nodes.set(position, node);
  });
  const formulas = new Map<PmNode, number>();
  for (const item of value.formulas) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("position" in item) ||
      typeof item.position !== "number" ||
      !Number.isSafeInteger(item.position) ||
      !("line" in item) ||
      typeof item.line !== "number" ||
      !Number.isSafeInteger(item.line) ||
      item.line < 1
    )
      throw new Error("导出公式源码标注无效");
    const node = nodes.get(item.position);
    if (!node || formulas.has(node)) throw new Error("导出公式源码身份无效");
    formulas.set(node, item.line);
  }
  if (formulas.size !== nodes.size) throw new Error("导出公式源码标注不完整");
  return { doc, formulas };
}
