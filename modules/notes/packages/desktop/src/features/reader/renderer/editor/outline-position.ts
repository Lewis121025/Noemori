import type { Node as PmNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { collectOutline } from "../../shared/markdown/outline";

/**
 * 为一个不可变文档建立目录索引；滚动时复用条目，只读取定位所需的标题几何。
 * @param doc 当前编辑器文档；正文改变后应替换索引，选区变化无需重建。
 * @returns 目录条目和视口标题查询；不缓存像素位置，字体、图片与侧栏重排立即生效。
 * @throws 底层 DOM 测量异常原样传播。
 */
export function createOutlinePosition(doc: PmNode) {
  const items = collectOutline(doc);
  // 顶层标题按块流自上而下排列；嵌套容器（例如表格）没有这个几何单调性契约。
  const topLevel = new Set<number>();
  doc.forEach((node, pos) => {
    if (node.type.name === "heading") topLevel.add(pos);
  });
  const ordered = items.every((item) => topLevel.has(item.pos));
  return {
    items,
    /** 当前视口上沿所属的标题；文首沿用第一项，空目录或没有滚动区时返回 null。 */
    visibleHeading(view: EditorView): number | null {
      const viewport = view.dom.closest(".main")?.getBoundingClientRect();
      if (!viewport || items.length === 0) return null;
      const reached = (index: number): boolean => {
        const node = view.nodeDOM(items[index]!.pos);
        return node instanceof HTMLElement && node.getBoundingClientRect().top <= viewport.top + 24;
      };
      if (!ordered) {
        let current = items[0]!.pos;
        for (let index = 0; index < items.length; index += 1)
          if (reached(index)) current = items[index]!.pos;
        return current;
      }
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (reached(middle)) low = middle + 1;
        else high = middle;
      }
      return items[Math.max(0, low - 1)]!.pos;
    },
  };
}
