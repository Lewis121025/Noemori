/**
 * 快速切换器的候选构建与排序：纯函数，界面只负责渲染与按键。
 *
 * 候选是库内全部文件（含附件）；Markdown 额外按标题与别名匹配。
 * 空查询展示最近打开，最近记录不足时按路径顺序补足。
 */

import type { NoteKeys } from "../../shared/api";
import { fuzzyScore } from "../search/fuzzy";

/** 一次展示的候选上限。 */
export const SWITCHER_LIMIT = 50;

/** 文件名命中的额外加分：同分时文件名比路径中段更像用户要找的目标。 */
const NAME_BONUS = 200;

/** 一条可切换的文件。 */
export type SwitcherEntry = {
  /** 库内相对路径。 */
  path: string;
  /** 主行：Markdown 去 `.md` 的文件名，其他文件保留扩展名。 */
  label: string;
  /** 所在目录；根目录为空串。 */
  directory: string;
  /** Markdown 的展示标题；非 Markdown 为 `null`。 */
  title: string | null;
  /** Markdown 的别名。 */
  aliases: readonly string[];
};

/** 一条命中；`alias` 是让它命中的别名，其他键命中时为 `null`。 */
export type SwitcherHit = { entry: SwitcherEntry; alias: string | null };

/**
 * 由文件列表和笔记身份组装候选。
 *
 * @param files 库内文件路径（已按路径排序）。
 * @param keys 索引给出的 Markdown 标题与别名；不在 `files` 里的路径忽略。
 */
export function switcherEntries(
  files: readonly string[],
  keys: readonly NoteKeys[],
): SwitcherEntry[] {
  const byPath = new Map(keys.map((note) => [note.path, note]));
  return files.map((path) => {
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    const markdown = name.toLowerCase().endsWith(".md");
    const note = byPath.get(path);
    return {
      path,
      label: markdown ? name.slice(0, -3) : name,
      directory: slash < 0 ? "" : path.slice(0, slash),
      title: markdown ? (note?.title ?? name.slice(0, -3)) : null,
      aliases: note?.aliases ?? [],
    };
  });
}

/**
 * 排序候选。
 *
 * @param query 用户输入；大小写不敏感。
 * @param entries {@link switcherEntries} 的结果。
 * @param recent 最近打开路径，最新在前；已不存在的路径跳过。
 * @returns 至多 {@link SWITCHER_LIMIT} 条命中。
 */
export function rankSwitcher(
  query: string,
  entries: readonly SwitcherEntry[],
  recent: readonly string[],
): SwitcherHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return byRecent(entries, recent);
  const scored: Array<{ hit: SwitcherHit; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const keys: Array<{ text: string; bonus: number; alias: string | null }> = [
      { text: entry.label, bonus: NAME_BONUS, alias: null },
      { text: entry.path, bonus: 0, alias: null },
      ...(entry.title === null ? [] : [{ text: entry.title, bonus: 0, alias: null }]),
      ...entry.aliases.map((name) => ({ text: name, bonus: 0, alias: name })),
    ];
    let best: { score: number; alias: string | null } | null = null;
    for (const key of keys) {
      const score = fuzzyScore(needle, key.text.toLowerCase(), "/ ");
      if (score !== null && (best === null || score + key.bonus > best.score))
        best = { score: score + key.bonus, alias: key.alias };
    }
    if (best !== null) scored.push({ hit: { entry, alias: best.alias }, score: best.score, index });
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.slice(0, SWITCHER_LIMIT).map(({ hit }) => hit);
}

function byRecent(entries: readonly SwitcherEntry[], recent: readonly string[]): SwitcherHit[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const out: SwitcherHit[] = [];
  const seen = new Set<string>();
  for (const path of recent) {
    const entry = byPath.get(path);
    if (entry === undefined || seen.has(path)) continue;
    seen.add(path);
    out.push({ entry, alias: null });
  }
  for (const entry of entries) {
    if (out.length >= SWITCHER_LIMIT) break;
    if (!seen.has(entry.path)) out.push({ entry, alias: null });
  }
  return out.slice(0, SWITCHER_LIMIT);
}

/**
 * 由查询生成新笔记路径（`Shift+Enter` 或无命中时的创建）。
 *
 * @returns 补齐 `.md` 的库内相对路径；空查询返回 `null`。名称合法性由创建事务校验。
 */
export function createNotePath(query: string): string | null {
  const trimmed = query
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (trimmed === "") return null;
  return trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
}
