import type { Node as PmNode } from "prosemirror-model";
import { parseEditorRecovery } from "../../../shared/editor-recovery";
import { documentSchema } from "./schema";

/** 原始源码用于重建保真映射，editor 保存最新不可变文档；两者都不能直接覆盖笔记。 */
export type MarkdownRecoverySnapshot = { source: Uint8Array; editor: string; revision: number };

/** 快照生成失败仍携带同版本的完整编辑，供文档保存流程持久化到恢复记录。 */
export class MarkdownSnapshotError extends Error {
  readonly recovery: MarkdownRecoverySnapshot;

  /** @param cause 保真映射的具体原因；原始异常保留供本地诊断。 */
  constructor(source: string, document: PmNode, revision: number, cause: unknown) {
    super("当前修改暂时无法保真保存到 Markdown，原文件未改动。", { cause });
    this.name = "MarkdownSnapshotError";
    this.recovery = {
      source: new TextEncoder().encode(source),
      editor: JSON.stringify({
        format: "nous.prosemirror",
        version: 1,
        revision,
        doc: document.toJSON(),
      }),
      revision,
    };
  }
}

/**
 * 按当前 schema 验证恢复文档，禁止丢弃未知节点或在验证失败时降级为原源码。
 * @returns 最新内容和同一内容版本；只生成初始不可变节点，不建立第二套编辑模型。
 * @throws 未知版本、损坏 JSON、非法节点、标记或属性时抛错，调用方须保留恢复记录。
 */
export function restoreMarkdownRecovery(editor: string): { doc: PmNode; revision: number } {
  const recovery = parseEditorRecovery(editor);
  try {
    const doc = documentSchema.nodeFromJSON(recovery.doc);
    doc.check();
    return { doc, revision: recovery.revision };
  } catch (cause) {
    throw new Error("编辑恢复文档不符合当前格式，恢复记录已保留，请使用兼容版本处理。", { cause });
  }
}
