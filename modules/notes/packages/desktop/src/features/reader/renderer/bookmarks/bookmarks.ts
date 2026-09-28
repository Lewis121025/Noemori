/**
 * 书签清单的纯逻辑：判等、增删、重排、显示名与失效判定。
 *
 * 书签以整表为单位写回库内文件，所以这里的操作都返回新数组，
 * 调用方拿到结果后整体提交；原数组保持不变，便于提交失败时回退。
 */

import type { Bookmark, VaultEntry } from "../../shared/api";
import { normalizeHeadingText } from "../links/heading-anchor";

/**
 * 两条书签是否指向同一目标；显示名不参与比较。
 *
 * 标题按锚点归一化规则比较，与跳转时的匹配口径一致。
 */
export function sameBookmark(a: Bookmark, b: Bookmark): boolean {
  switch (a.kind) {
    case "search":
      return b.kind === "search" && a.query === b.query;
    case "heading":
      return (
        b.kind === "heading" &&
        a.path === b.path &&
        normalizeHeadingText(a.heading) === normalizeHeadingText(b.heading)
      );
    default:
      return b.kind === a.kind && a.path === b.path;
  }
}

/** 已收藏则移除，否则追加到末尾。 */
export function toggleBookmark(list: readonly Bookmark[], target: Bookmark): Bookmark[] {
  return list.some((item) => sameBookmark(item, target))
    ? list.filter((item) => !sameBookmark(item, target))
    : [...list, target];
}

/**
 * 拖放重排：把 `from` 处的书签插到原清单 `to` 处那一行之前。
 *
 * `to` 取原清单下标，`list.length` 表示放到末尾；越界收敛到两端。
 * @returns 顺序未变或 `from` 越界时返回原数组，调用方据此跳过写盘。
 */
export function moveBookmark(
  list: readonly Bookmark[],
  from: number,
  to: number,
): readonly Bookmark[] {
  const item = list[from];
  const before = Math.max(0, Math.min(to, list.length));
  const target = from < before ? before - 1 : before;
  if (item === undefined || target === from) return list;
  const next = list.filter((_, index) => index !== from);
  next.splice(target, 0, item);
  return next;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function noteName(path: string): string {
  const name = baseName(path);
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/** 侧栏显示名：自定义名优先；笔记去掉 `.md`，标题书签带上所在笔记。 */
export function bookmarkLabel(bookmark: Bookmark): string {
  if (bookmark.title !== null && bookmark.title !== "") return bookmark.title;
  switch (bookmark.kind) {
    case "file":
      return noteName(bookmark.path);
    case "folder":
      return baseName(bookmark.path);
    case "heading":
      return `${noteName(bookmark.path)} › ${bookmark.heading}`;
    case "search":
      return bookmark.query;
  }
}

/**
 * 书签目标是否已不在库里。
 *
 * 只剩恢复草稿的路径视为失效：原文件已经不在磁盘上。
 * 标题是否仍存在要打开笔记才知道，这里只判定所在文件。
 */
export function bookmarkMissing(bookmark: Bookmark, entries: readonly VaultEntry[]): boolean {
  if (bookmark.kind === "search") return false;
  const kind = bookmark.kind === "folder" ? "directory" : "file";
  return !entries.some(
    (entry) => entry.path === bookmark.path && entry.kind === kind && !entry.recoveryOnly,
  );
}
