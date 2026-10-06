import {
  findFileTreeNode,
  visibleFileRows,
  type FileTreeNode,
  type FileTreeRow,
} from "./file-tree";

/**
 * 文件系统按当前文件夹展示网格；有查询时按完整路径搜索整个库。
 * @param tree 已按文件夹优先和自然名称排序的完整目录。
 * @param directory 当前库内文件夹，空字符串表示库根。
 * @param query 文件名或路径关键词，不改写目录的展开状态。
 * @returns 网格中的完整条目次序；不存在的文件夹返回空数组。
 */
export function fileGridRows(
  tree: FileTreeNode[],
  directory: string,
  query: string,
): FileTreeRow[] {
  const text = query.trim().toLocaleLowerCase();
  if (text !== "")
    return visibleFileRows(tree, new Set(), true).filter((row) =>
      row.node.path.toLocaleLowerCase().includes(text),
    );
  const children = directory === "" ? tree : (findFileTreeNode(tree, directory)?.children ?? []);
  return visibleFileRows(children, new Set());
}

/**
 * 网格方向键按实际列数移动；末行缺席的单元格回到最后一个文件。
 * @param index 当前文件在完整列表中的索引。
 * @param count 完整文件数。
 * @param columns 当前布局的正整数列数。
 * @param key 方向键或 Home / End。
 * @returns 合法目标索引；不支持的键或空网格返回 null。
 */
export function gridTarget(
  index: number,
  count: number,
  columns: number,
  key: string,
): number | null {
  if (count === 0) return null;
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? count - 1
        : key === "ArrowLeft"
          ? index - 1
          : key === "ArrowRight"
            ? index + 1
            : key === "ArrowUp"
              ? index - columns
              : key === "ArrowDown"
                ? index + columns
                : null;
  return next === null ? null : Math.max(0, Math.min(count - 1, next));
}
