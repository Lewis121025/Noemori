import { createHash } from "node:crypto";
import type { Node as PmNode } from "prosemirror-model";
import { documentSchema } from "../../shared/markdown/schema";
import { isEntryPath } from "../../shared/file-browser";
import type { PreparedExportDocument } from "./documents";
import type { NativeExport } from "./native";

/** 原文身份与节点位置随磁盘暂存一同冻结，重载不能把嵌入链接误归主文档。 */
export type ExportOrigin = { path: string; position: number };
/** 全局只持有输出路径及锚点；正文树按篇从任务暂存中读取。 */
export type StoredExportDocument = Pick<
  PreparedExportDocument,
  "path" | "output" | "anchors" | "locations"
> & { file: string };

/** 转换文档按阶段暂存并逐篇重载，防止批量转换把整个库的正文树放入内存。 */
export class ExportDocumentStore {
  readonly records = new Map<string, StoredExportDocument>();

  /** @param native 任务拥有的有限暂存能力；任何 IO 或哈希错误继续阻止整批提交。 */
  constructor(private readonly native: NativeExport) {}

  /** 保存一篇文档及来源映射；每阶段只写一次，重复阶段作为程序错误拒绝。 */
  async put(
    document: PreparedExportDocument,
    origins: WeakMap<PmNode, ExportOrigin>,
    formulas: WeakMap<PmNode, { path: string; line: number }>,
    phase: "prepared" | "resolved",
  ): Promise<void> {
    const annotations: {
      position: number;
      origin: ExportOrigin | null;
      formula: { path: string; line: number } | null;
    }[] = [];
    document.doc.descendants((node, position) => {
      const origin = origins.get(node) ?? null;
      const formula = document.formulaLocations.get(node) ?? formulas.get(node) ?? null;
      if (origin || formula) annotations.push({ position, origin, formula });
    });
    const file = `working/${phase}/${createHash("sha256").update(document.path).digest("hex")}.json`;
    await this.native.write(
      file,
      new TextEncoder().encode(JSON.stringify({ doc: document.doc.toJSON(), annotations })),
    );
    this.records.set(document.path, {
      path: document.path,
      output: document.output,
      anchors: document.anchors,
      locations: document.locations,
      file,
    });
  }

  /** 仅重载通过任务哈希校验的文档；还原来源与公式行号后才交给下一阶段。 */
  async get(
    record: StoredExportDocument,
    origins: WeakMap<PmNode, ExportOrigin>,
    formulas: WeakMap<PmNode, { path: string; line: number }>,
  ): Promise<PreparedExportDocument> {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await this.native.readOutput(record.file)),
    );
    if (!object(value) || !Array.isArray(value.annotations) || !("doc" in value))
      throw new Error("暂存文档结构无效");
    const doc = documentSchema.nodeFromJSON(value.doc);
    doc.check();
    if (doc.type !== documentSchema.topNodeType) throw new Error("暂存文档根结构无效");
    const nodes = new Map<number, PmNode>();
    doc.descendants((node, position) => {
      nodes.set(position, node);
    });
    const annotated = new Set<number>();
    const formulaLocations = new Map<PmNode, { path: string; line: number }>();
    for (const annotation of value.annotations) {
      if (
        !object(annotation) ||
        typeof annotation.position !== "number" ||
        !Number.isSafeInteger(annotation.position) ||
        annotation.position < 0 ||
        annotated.has(annotation.position) ||
        (annotation.origin === null && annotation.formula === null)
      )
        throw new Error("暂存文档节点位置无效");
      annotated.add(annotation.position);
      const node = nodes.get(annotation.position);
      if (!node) throw new Error("暂存文档节点丢失");
      if (annotation.origin !== null) {
        const origin = annotation.origin;
        if (
          !object(origin) ||
          !isEntryPath(origin.path) ||
          typeof origin.position !== "number" ||
          !Number.isSafeInteger(origin.position) ||
          origin.position < -1
        )
          throw new Error("暂存文档来源无效");
        origins.set(node, { path: origin.path, position: origin.position });
      }
      if (annotation.formula !== null) {
        const formula = annotation.formula;
        if (
          !object(formula) ||
          !isEntryPath(formula.path) ||
          !["math_inline", "math_block"].includes(node.type.name) ||
          typeof formula.line !== "number" ||
          !Number.isSafeInteger(formula.line) ||
          formula.line < 1
        )
          throw new Error("暂存公式位置无效");
        const location = { path: formula.path, line: formula.line };
        formulaLocations.set(node, location);
        formulas.set(node, location);
      }
    }
    return {
      path: record.path,
      output: record.output,
      anchors: record.anchors,
      locations: record.locations,
      doc,
      formulaLocations,
    };
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
