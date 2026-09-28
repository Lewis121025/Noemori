import { diff } from "@codemirror/merge";
import { ChangeSet } from "@codemirror/state";
import type { Node as PmNode } from "prosemirror-model";
import { StepMap } from "prosemirror-transform";

// 只为重载后的导航计算差异；大范围替换限制精细比较成本，保存始终使用新的原始源码。
const diffOptions = { scanLimit: 1000, timeout: 20 };

/** 文本重载的位置映射；保留分散修改之间的选区，UTF-16 位置与 CodeMirror 一致。 */
export function textReloadChanges(before: string, after: string): ChangeSet {
  return ChangeSet.of(
    diff(before, after, diffOptions).map(({ fromA, toA, fromB, toB }) => ({
      from: fromA,
      to: toA,
      insert: after.slice(fromB, toB),
    })),
    before.length,
  );
}

/**
 * 生成仅用于定位的文档投影，每个节点边界占一位，与 ProseMirror 位置严格对应。
 * C0 占位符不会进入保存内容；文件解码契约排除了这些控制字符，格式变化不影响文字定位。
 */
function positionText(doc: PmNode): string {
  const parts: string[] = [];
  function append(node: PmNode): void {
    if (node.isText) parts.push(node.text ?? "");
    else if (node.isLeaf) parts.push("\u0002");
    else {
      parts.push("\u0000");
      node.forEach(append);
      parts.push("\u0001");
    }
  }
  doc.forEach(append);
  return parts.join("");
}

/**
 * 将旧文档的选区、弹窗书签和阅读锚点映射到外部版本，不修改任何文档或撤销历史。
 * 已删除的位置落到最近的替换边界，再由 Selection.map 选择合法的光标或节点位置。
 */
export function markdownReloadMapping(before: PmNode, after: PmNode): StepMap {
  return new StepMap(
    diff(positionText(before), positionText(after), diffOptions).flatMap(
      ({ fromA, toA, fromB, toB }) => [fromA, toA - fromA, toB - fromB],
    ),
  );
}
