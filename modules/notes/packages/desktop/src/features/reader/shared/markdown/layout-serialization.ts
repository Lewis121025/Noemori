import type { Options } from "remark-stringify";
import type { Nodes } from "mdast";

/**
 * 空段落的缩进属于其容器；保留空行上的缩进，重新解析时才能区分项内空段与项外空段。
 * 仅提供流式容器的生成器，行内转义、列表标记选择及源码位置跟踪仍使用共用处理器。
 */
export const layoutHandlers: NonNullable<Options["handlers"]> = {
  listItem(node, parent, state, info) {
    let marker = state.bulletCurrent ?? "-";
    if (parent?.type === "list" && parent.ordered)
      marker = String((parent.start ?? 1) + parent.children.indexOf(node)) + marker;
    const indent = " ".repeat(marker.length + 1);
    const tracker = state.createTracker(info);
    tracker.move(marker + " ");
    tracker.shift(indent.length);
    const exit = state.enter("listItem");
    const first = node.children[0];
    const content =
      typeof node.checked === "boolean" && first?.type === "paragraph"
        ? {
            ...node,
            children: [
              {
                ...first,
                children: [
                  { type: "rawMarkdown" as const, value: `[${node.checked ? "x" : " "}] ` },
                  ...first.children,
                ],
              },
              ...node.children.slice(1),
            ],
          }
        : node;
    const body = state.containerFlow(content, tracker.current());
    const retainIndent = containsBlank(node);
    exit();
    return state.indentLines(body, (line, index, blank) =>
      index === 0
        ? marker + (line === "" ? "" : " " + line)
        : (blank && !retainIndent ? "" : indent) + line,
    );
  },
  footnoteDefinition(node, _parent, state, info) {
    const tracker = state.createTracker(info);
    const exit = state.enter("footnoteDefinition");
    const labelExit = state.enter("label");
    const label = state.safe(state.associationId(node), { before: "[^", after: "]" });
    labelExit();
    const marker = `[^${label}]: `;
    tracker.move(marker);
    tracker.shift(4);
    const body = state.containerFlow(node, tracker.current());
    const retainIndent = containsBlank(node);
    exit();
    return (
      marker +
      state.indentLines(body, (line, index, blank) =>
        index === 0 || (blank && !retainIndent) ? line : "    " + line,
      )
    );
  },
};

function containsBlank(node: Nodes): boolean {
  return (
    (node.type === "paragraph" && node.children.length === 0) ||
    ("children" in node && node.children.some(containsBlank))
  );
}
