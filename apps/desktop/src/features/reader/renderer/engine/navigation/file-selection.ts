/** 范围锚点与焦点分离；反向缩小范围时不把上一轮的临时范围累积进选择。 */
export type FileSelection = { paths: ReadonlySet<string>; anchor: string | null };

/**
 * 在当前可见行中选择；toggle 用于 ⌘/Ctrl，range 用于 Shift，extend 用于组合修饰键。
 * 隐藏条目不参与范围且不会被继续操作；目标不在可见行时原样返回。
 */
export function selectFileRows(
  selection: FileSelection,
  visible: readonly string[],
  target: string,
  mode: "replace" | "toggle" | "range" | "extend",
): FileSelection {
  const end = visible.indexOf(target);
  if (end < 0) return selection;
  if (mode === "replace") return { paths: new Set([target]), anchor: target };
  const retained = new Set(visible.filter((path) => selection.paths.has(path)));
  if (mode === "toggle") {
    if (retained.has(target)) retained.delete(target);
    else retained.add(target);
    return { paths: retained, anchor: target };
  }
  const anchored = visible.indexOf(selection.anchor ?? target);
  const start = anchored < 0 ? end : anchored;
  const range = visible.slice(Math.min(start, end), Math.max(start, end) + 1);
  return {
    paths: new Set(mode === "extend" ? [...retained, ...range] : range),
    anchor: visible[start] ?? target,
  };
}
