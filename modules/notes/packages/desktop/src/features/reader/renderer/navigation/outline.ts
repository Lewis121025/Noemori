/**
 * 从文档树抽出标题大纲。只读文档，不改节点、不写回 Markdown。
 */
import type { Node as PmNode } from "prosemirror-model";

/** 大纲里的一条标题。`pos` 是该 heading 节点在文档中的起点，供跳转。 */
export type OutlineItem = {
  level: number;
  text: string;
  pos: number;
};

/** 按标题层级嵌套后的大纲节点。`key` 是树路径，折叠状态跟它走，不跟 pos 走。 */
export type OutlineNode = {
  item: OutlineItem;
  key: string;
  children: OutlineNode[];
};

/**
 * 按文档顺序收集非空标题。
 *
 * @param doc schema 约束下的文档节点。
 * @returns 大纲条目；空标题和代码块里的 `#` 不会出现。
 */
export function collectOutline(doc: PmNode): OutlineItem[] {
  const out: OutlineItem[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const text = headingText(node);
      if (text !== "") {
        const level = Number(node.attrs["level"] ?? 1);
        out.push({
          level: Number.isFinite(level) ? level : 1,
          text,
          pos,
        });
      }
      return false;
    }
    // 标题只出现在块级容器里；段落/代码等 textblock 不必再往下走。
    if (node.isTextblock) {
      return false;
    }
    return true;
  });
  return out;
}

/**
 * 大纲条目是否完全一致。标题没变时外壳不必重绘侧栏。
 *
 * @param left 上一份大纲。
 * @param right 新算出的大纲。
 */
export function outlineEquals(left: OutlineItem[], right: OutlineItem[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      return false;
    }
    if (a.pos !== b.pos || a.level !== b.level || a.text !== b.text) {
      return false;
    }
  }
  return true;
}

/**
 * 把扁平大纲收成树：后一个标题挂到最近的、层级更小的标题下面。
 *
 * @param items `collectOutline` 的结果，须保持文档顺序。
 */
export function buildOutlineTree(items: OutlineItem[]): OutlineNode[] {
  const root: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const item of items) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined || top.item.level < item.level) {
        break;
      }
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const index = parent === undefined ? root.length : parent.children.length;
    const key = parent === undefined ? String(index) : `${parent.key}.${index}`;
    const node: OutlineNode = { item, key, children: [] };
    if (parent === undefined) {
      root.push(node);
    } else {
      parent.children.push(node);
    }
    stack.push(node);
  }
  return root;
}

/**
 * 标题的可读文本：wiki 链接取别名（无别名取目标），行内公式取 TeX 源码。
 *
 * 大纲展示与锚点匹配共用同一提取规则，保证「看到的标题」就是「可链接的锚点」。
 */
export function headingText(node: PmNode): string {
  const parts: string[] = [];
  node.forEach((child) => {
    if (child.isText) {
      parts.push(child.text ?? "");
      return;
    }
    if (child.type.name === "wiki_link") {
      const alias = child.attrs["alias"];
      const target = String(child.attrs["target"] ?? "");
      parts.push(typeof alias === "string" && alias !== "" ? alias : target);
      return;
    }
    if (child.type.name === "math_inline") {
      parts.push(String(child.attrs["tex"] ?? ""));
    }
  });
  return parts.join("").trim();
}
