import type { VaultEntry } from "../../../shared/api";
import { ancestorDirectories, parentDirectory } from "./file-tree";
import { independentEntryPaths } from "../../../shared/entry-batch";

/** 移动目标使用库内路径；空字符串代表库根，reason 非空时只展示原因而不允许提交。 */
export type MoveDestination = {
  path: string;
  reason: "当前位置" | "已有同名条目" | null;
};

const compare = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/**
 * 计算真实可用目录，排除源条目及其后代，保留不可选目标的具体原因。
 * @param entries 当前库快照；恢复草稿占用的路径也不能被移动覆盖。
 * @param source 要移动的文件或目录；多选时父文件夹覆盖其后代，不得包含库根。
 * @returns 库根优先、路径自然排序的候选；最终提交仍由内核检查并发变化。
 */
export function moveDestinations(
  entries: readonly VaultEntry[],
  source: VaultEntry | readonly VaultEntry[],
): MoveDestination[] {
  const sources = independentEntryPaths(
    "path" in source ? [source.path] : source.map((entry) => entry.path),
  );
  const occupied = new Set(
    entries.flatMap((entry) => [entry.path, ...ancestorDirectories(entry.path)]),
  );
  const items = sources.map((path) => ({
    path,
    parent: parentDirectory(path),
    name: path.split("/").at(-1)!,
  }));
  const directories = [
    ...new Set(
      entries
        .filter(
          (entry) =>
            entry.kind === "directory" &&
            !entry.recoveryOnly &&
            !sources.some((source) => entry.path === source || entry.path.startsWith(`${source}/`)),
        )
        .map((entry) => entry.path),
    ),
  ];
  directories.sort((left, right) => compare.compare(left, right) || left.localeCompare(right));
  return ["", ...directories].map((path) => {
    const names = new Set<string>();
    const conflict = items.some((item) => {
      const to = path === "" ? item.name : `${path}/${item.name}`;
      const duplicate = names.has(to);
      names.add(to);
      return duplicate || (to !== item.path && occupied.has(to));
    });
    return {
      path,
      reason: items.every((item) => item.parent === path)
        ? "当前位置"
        : conflict
          ? "已有同名条目"
          : null,
    };
  });
}
