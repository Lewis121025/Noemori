import { Plugin, PluginKey } from "prosemirror-state";
import type { Node as PmNode } from "prosemirror-model";
import { articleConversationId } from "../../../shared/article-conversations";

/** 对话创建期间的插入点随正文事务映射；位置被删除后必须重新选择，不能插到附近。 */
export const conversationInsertion = new PluginKey<number | null>("article-conversation-insertion");

/** 仅持有当前编辑器的临时位置，不写正文、不持久化，销毁编辑器即释放。 */
export function conversationInsertionPlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: conversationInsertion,
    state: {
      init: () => null,
      apply(tr, previous) {
        const action: unknown = tr.getMeta(conversationInsertion);
        if (action === null || typeof action === "number") return action;
        if (previous === null || !tr.docChanged) return previous;
        const mapped = tr.mapping.mapResult(previous, -1);
        return mapped.deleted ? null : mapped.pos;
      },
    },
  });
}

/** 定位唯一入口，链接内格式拆分合并为同一范围；重复入口返回 null，禁止任取第一个。 */
export function conversationRange(doc: PmNode, id: string): { from: number; to: number } | null {
  const ranges: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (
      !node.marks.some(
        (mark) =>
          mark.type.name === "link" &&
          typeof mark.attrs["href"] === "string" &&
          articleConversationId(mark.attrs["href"]) === id,
      )
    )
      return;
    const last = ranges.at(-1);
    if (last?.to === pos) last.to += node.nodeSize;
    else ranges.push({ from: pos, to: pos + node.nodeSize });
  });
  return ranges.length === 1 ? ranges[0]! : null;
}
