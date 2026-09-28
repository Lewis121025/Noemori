/**
 * 链接补全候选排序：编辑器内联补全、链接对话框与源码模式共用。
 *
 * 纯函数、零依赖。排序规则可解释：
 *
 * 1. 子串命中优先于子序列（模糊）命中；
 * 2. 子串命中越靠前越好，命中文件名或路径段开头有额外加分；
 * 3. 子序列命中按跨度打分，跨度越短越好；
 * 4. 空查询保持传入顺序（库文件列表本身按路径排序）。
 */

import type { NoteKeys } from "../../../../shared/api";
import type { BlockCandidate } from "../../../links/block-list";
import { fuzzyScore, rankByFuzzy, subsequenceSpan } from "../../../search/fuzzy";

/** 一条补全候选。 */
export type LinkSuggestion = {
  /** 应插入到光标处的文本；块候选是块在清单中的序号。 */
  value: string;
  /** 展示主行。 */
  label: string;
  /** 展示副行；空串表示没有。 */
  detail: string;
  /** 别名候选插入 `[[目标|别名]]`；其他候选缺省。 */
  alias?: string;
};

/** 弹层一次展示的候选上限。 */
export const SUGGESTION_LIMIT = 8;

/**
 * 库内 Markdown 路径的补全排序。
 *
 * @param query 已输入的目标片段；空串返回前 `SUGGESTION_LIMIT` 条。
 * @param files 库内相对路径（调用方已过滤 `.md`）。
 * @param notes 笔记身份；有查询时别名也参与匹配，命中插入 `[[路径|别名]]`。
 */
export function rankFileCandidates(
  query: string,
  files: readonly string[],
  notes: readonly NoteKeys[] = [],
): LinkSuggestion[] {
  const needle = query.trim().toLowerCase();
  const scored: Array<{ suggestion: LinkSuggestion; score: number; key: string }> = [];
  for (const path of files) {
    const score = scoreFile(needle, path);
    if (score !== null)
      scored.push({
        suggestion: { value: path.slice(0, path.length - 3), label: basename(path), detail: path },
        score,
        key: path,
      });
  }
  if (needle !== "") {
    const present = new Set(files);
    for (const note of notes) {
      if (!present.has(note.path)) continue;
      for (const alias of note.aliases) {
        const score = fuzzyScore(needle, alias.toLowerCase());
        if (score === null) continue;
        scored.push({
          suggestion: {
            value: note.path.slice(0, note.path.length - 3),
            label: alias,
            detail: `别名 · ${note.path}`,
            alias,
          },
          score: score + (alias.toLowerCase().startsWith(needle) ? 200 : 0),
          key: `${note.path}|${alias}`,
        });
      }
    }
  }
  scored.sort(
    (left, right) =>
      right.score - left.score || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
  return scored.slice(0, SUGGESTION_LIMIT).map(({ suggestion }) => suggestion);
}

/**
 * 目标文件可引用块的补全排序。
 *
 * @param query 已输入的块查询（`^` 之后）；按块文字与已有 ID 匹配。
 * @param blocks 目标文件的块清单，按文档顺序。
 */
export function rankBlockCandidates(
  query: string,
  blocks: readonly BlockCandidate[],
): LinkSuggestion[] {
  return rankByFuzzy(query, blocks, (block) => [block.text, block.id ?? ""], SUGGESTION_LIMIT).map(
    (block) => ({
      value: String(block.index),
      label: block.text,
      detail: block.id === null ? "块 · 将写入新 ID" : `^${block.id}`,
    }),
  );
}

/**
 * 目标文件标题的锚点补全排序。
 *
 * @param query 已输入的锚点片段。
 * @param headings 目标文件的标题文本，按文档顺序。
 */
export function rankHeadingCandidates(
  query: string,
  headings: readonly string[],
): LinkSuggestion[] {
  const needle = query.trim().toLowerCase();
  const scored: Array<{ text: string; score: number; index: number }> = [];
  headings.forEach((text, index) => {
    const lower = text.toLowerCase();
    const at = needle === "" ? 0 : lower.indexOf(needle);
    if (needle === "" || at >= 0) scored.push({ text, score: 1000 - at - index * 0.01, index });
    else {
      const span = subsequenceSpan(lower, needle);
      if (span !== null) scored.push({ text, score: 500 - span, index });
    }
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.slice(0, SUGGESTION_LIMIT).map(({ text }) => ({
    value: text,
    label: text,
    detail: "标题",
  }));
}

/** 插入值去掉 `.md` 后缀；wiki 目标以无扩展名形式最常用。 */
function basename(path: string): string {
  const stem = path.slice(0, path.length - 3);
  return stem.slice(stem.lastIndexOf("/") + 1);
}

function scoreFile(needle: string, path: string): number | null {
  if (needle === "") return 1;
  const lower = path.toLowerCase();
  const stem = lower.slice(0, lower.length - 3);
  const name = stem.slice(stem.lastIndexOf("/") + 1);
  const score = fuzzyScore(needle, lower, "/");
  // 文件名以查询开头必然是子串命中，加分只作用于子串分支。
  return score === null ? null : score + (name.startsWith(needle) ? 200 : 0);
}
