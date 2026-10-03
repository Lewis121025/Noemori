import { type Node as PmNode } from "prosemirror-model";
import { parseMarkdownDocument } from "../../shared/markdown/parse";
import { sameMarkdownContent } from "../../shared/markdown/serialize";
import { sourceTree, positionInTree, rangeInTree, sourceOffsetInTree } from "./source-map";
import { renderSource } from "./source-render";
import type { Transaction } from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import { MarkdownSnapshotError, restoreMarkdownRecovery } from "./session-recovery";

/** 保存快照携带内容版本，供异步写入核对后续输入。 */
export type EditorSnapshot = { bytes: Uint8Array; revision: number };

/**
 * 创建属于一次打开操作的 Markdown 编辑会话。
 * 原文和语法范围只读；保存按不可变文档节点复用源码，撤销可直接恢复原始字节。
 * @param source 包含 BOM 和原始换行的文本。
 * @param recovery 可选的版本化恢复记录，保留原始源码作为局部更新基准。
 * @returns 初始文档、局部更新后的保存快照和源码定位入口。
 * @throws 无法证明更新后的 Markdown 与编辑内容一致时拒绝生成保存快照。
 */
export function createMarkdownSession(source: string, recovery?: string) {
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const body = source.slice(bom);
  const initial = parseMarkdownDocument(body);
  const doc = initial.doc;
  let tree = sourceTree(initial.tree, doc, bom);
  tree.start = bom;
  tree.end = source.length;
  const originalTree = tree;
  const restored = recovery === undefined ? undefined : restoreMarkdownRecovery(recovery);
  let currentDoc = restored?.doc ?? doc;
  let navigationReady = restored === undefined;
  let sourceRevision = 0;
  let navigationSource = source;
  let changes = new Mapping();
  const snapshots = new WeakMap<PmNode, string>();
  snapshots.set(doc, source);
  let revision = restored?.revision ?? 0;

  return {
    doc: currentDoc,
    /**
     * 按编辑器实际应用顺序记录事务，只维护源码位置映射和版本。
     * @throws 事务不属于当前文档时拒绝混用会话，避免把别的文档位置套入当前文件。
     */
    track(transaction: Transaction): void {
      if (!transaction.before.eq(currentDoc)) throw new Error("编辑事务不属于当前源码会话");
      currentDoc = transaction.doc;
      if (transaction.docChanged) {
        revision += 1;
        changes.appendMapping(transaction.mapping);
      }
    },
    snapshot(current: PmNode): EditorSnapshot {
      if (!currentDoc.eq(current)) {
        // 纯转换调用方可直接提交不可变文档；交互编辑器通过 track 提供完整位置映射。
        revision += 1;
        currentDoc = current;
      }
      // 滚动结束与视图交接会读取同一快照；内容未变化时不重复解析整篇 Markdown。
      if (navigationReady && sourceRevision === revision)
        return { bytes: new TextEncoder().encode(navigationSource), revision };
      let text: string;
      try {
        const cached = snapshots.get(current);
        // 字节生成始终锚定打开时的源码；保存点只重置导航映射，不能改变撤销的保真基准。
        text = cached ?? (doc.eq(current) ? source : renderSource(source, originalTree, current));
        const parsed = parseMarkdownDocument(text.slice(bom));
        if (!sameMarkdownContent(parsed.doc, current))
          throw new Error("更新后的 Markdown 与当前编辑内容不一致");
        tree = sourceTree(parsed.tree, current, bom);
      } catch (cause) {
        throw new MarkdownSnapshotError(source, current, revision, cause);
      }
      snapshots.set(current, text);
      tree.start = bom;
      tree.end = text.length;
      sourceRevision = revision;
      navigationSource = text;
      navigationReady = true;
      // 快照成为新的源码锚点，旧事务映射可以释放，持续写作不会无限累积 StepMap。
      changes = new Mapping();
      return { bytes: new TextEncoder().encode(text), revision };
    },
    /** 将最近快照的 UTF-16 源码位置经过编辑事务定位；过期版本拒绝盲用偏移。 */
    positionAt(offset: number, expectedRevision = sourceRevision): number {
      if (!navigationReady) throw new Error("恢复内容尚未生成有效源码，请先完成当前编辑");
      if (expectedRevision !== sourceRevision) throw new Error("源码位置版本已过期，请重新定位");
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > navigationSource.length)
        throw new Error("源码位置不在当前快照范围内");
      return changes.map(positionInTree(tree, navigationSource, offset, -1));
    },
    /** 反向映射必须先取得当前快照；未保存的新字符不能借用旧源码的偏移。 */
    sourceOffsetAt(position: number): number {
      if (!navigationReady || sourceRevision !== revision)
        throw new Error("请先取得当前编辑内容的保真快照");
      if (!Number.isSafeInteger(position) || position < 0 || position > currentDoc.content.size)
        throw new RangeError("排版位置不在当前文档范围内");
      return sourceOffsetInTree(tree, navigationSource, position);
    },
    /** 精确定位只接受未发生编辑的快照；异步版本核对期间发生输入也必须拒绝旧范围。 */
    rangeAt(
      start: number,
      end: number,
      expectedRevision: number,
    ): { from: number; to: number } | null {
      if (!navigationReady || expectedRevision !== sourceRevision || expectedRevision !== revision)
        throw new Error("搜索结果已过期，请重新搜索后定位。");
      return rangeInTree(tree, navigationSource, start, end);
    },
  };
}
