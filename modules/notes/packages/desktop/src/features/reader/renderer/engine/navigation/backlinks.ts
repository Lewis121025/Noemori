/**
 * 入链展示：按源文件分组，过滤、排序、截断上下文，并算出跳转用的第 n 次。
 */

import type { MentionRecord } from "../../../shared/api";

/** 入链分组的排序。 */
export type MentionSort = "pathAsc" | "pathDesc" | "mtimeAsc" | "mtimeDesc";

/** 同一源文件下的一组提及。 */
export type MentionGroup = {
  /** 源文件库内相对路径。 */
  fromPath: string;
  /** 源文件展示标题。 */
  fromTitle: string;
  /** 源文件内容修改时间。 */
  mtime: number;
  /** 该文件内按出现顺序的提及。 */
  items: MentionRecord[];
};

/**
 * 按首次出现顺序分组；组内保留全部提及，不去重。
 *
 * @param mentions 已链接或未链接记录。
 */
export function groupMentions(mentions: readonly MentionRecord[]): MentionGroup[] {
  const groups: MentionGroup[] = [];
  const indexByPath = new Map<string, number>();
  for (const item of mentions) {
    const existing = indexByPath.get(item.fromPath);
    if (existing === undefined) {
      indexByPath.set(item.fromPath, groups.length);
      groups.push({
        fromPath: item.fromPath,
        fromTitle: item.fromTitle,
        mtime: item.mtime,
        items: [item],
      });
      continue;
    }
    groups[existing]?.items.push(item);
  }
  return groups;
}

/**
 * 过滤后分组再排序。空查询不过滤。
 *
 * @param mentions 原始提及。
 * @param options.query 子串，匹配路径、标题、snippet。
 * @param options.sort 分组排序。
 */
export function presentMentions(
  mentions: readonly MentionRecord[],
  options: { query: string; sort: MentionSort },
): MentionGroup[] {
  const needle = options.query.trim().toLowerCase();
  const filtered =
    needle === ""
      ? [...mentions]
      : mentions.filter((item) => {
          return (
            item.fromPath.toLowerCase().includes(needle) ||
            item.fromTitle.toLowerCase().includes(needle) ||
            item.snippet.toLowerCase().includes(needle)
          );
        });
  const groups = groupMentions(filtered);
  return sortMentionGroups(groups, options.sort);
}

function sortMentionGroups(groups: MentionGroup[], sort: MentionSort): MentionGroup[] {
  const copy = [...groups];
  copy.sort((left, right) => {
    switch (sort) {
      case "pathAsc":
        return compareTitle(left, right);
      case "pathDesc":
        return compareTitle(right, left);
      case "mtimeDesc":
        return right.mtime - left.mtime || compareTitle(left, right);
      case "mtimeAsc":
        return left.mtime - right.mtime || compareTitle(left, right);
    }
  });
  return copy;
}

function compareTitle(left: MentionGroup, right: MentionGroup): number {
  const byTitle = left.fromTitle.localeCompare(right.fromTitle, "zh");
  if (byTitle !== 0) {
    return byTitle;
  }
  return left.fromPath.localeCompare(right.fromPath, "zh");
}

const DEFAULT_SNIPPET_CHARS = 180;

/**
 * 折叠上下文时截断段落，尽量把命中留在窗口里。
 *
 * @param snippet 整段上下文。
 * @param moreContext 为真则不截断。
 * @param maxChars 折叠时的最大字符数。
 * @param match 要尽量保留的命中文本。
 */
export function displaySnippet(
  snippet: string,
  moreContext: boolean,
  maxChars = DEFAULT_SNIPPET_CHARS,
  match?: string,
): string {
  if (moreContext || snippet.length <= maxChars) {
    return snippet;
  }
  let start = 0;
  if (match !== undefined && match !== "") {
    const at = snippet.toLowerCase().indexOf(match.toLowerCase());
    if (at >= 0) {
      start = Math.max(0, at - Math.floor((maxChars - match.length) / 2));
    }
  }
  if (start + maxChars > snippet.length) {
    start = Math.max(0, snippet.length - maxChars);
  }
  let slice = snippet.slice(start, start + maxChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = start + maxChars < snippet.length ? "…" : "";
  if (prefix !== "") {
    slice = slice.slice(1);
  }
  if (suffix !== "") {
    slice = slice.slice(0, Math.max(0, slice.length - 1));
  }
  return `${prefix}${slice}${suffix}`;
}

/**
 * 打开源文件后要找的第几次出现（从 1 计）。
 *
 * wiki / md 按同类链接的 `toRaw`；未链接按大小写不敏感的命中文本。
 *
 * @param all 当前笔记的全部提及，用来定位同一文件里的次序。
 * @param mention 用户点的那一条。
 */
export function mentionOccurrenceIndex(
  all: readonly MentionRecord[],
  mention: MentionRecord,
): number {
  let count = 0;
  for (const item of all) {
    if (item.fromPath !== mention.fromPath) {
      continue;
    }
    if (!sameJumpKey(item, mention)) {
      continue;
    }
    if (item.startByte <= mention.startByte) {
      count += 1;
    }
  }
  return count;
}

function sameJumpKey(left: MentionRecord, right: MentionRecord): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "unlinked") {
    return left.toRaw.localeCompare(right.toRaw, undefined, { sensitivity: "accent" }) === 0;
  }
  return left.linkKind === right.linkKind && left.toRaw === right.toRaw;
}
