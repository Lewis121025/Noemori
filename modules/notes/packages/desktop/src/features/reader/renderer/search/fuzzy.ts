/**
 * 模糊匹配打分：链接补全、快速切换器与命令面板共用同一套可解释规则。
 *
 * 1. 子串命中优先于子序列命中：子串得分 `1000 - 起点`，子序列得分 `500 - 跨度`；
 * 2. 子串起点落在词首（开头或 `boundaries` 中的分隔符之后）额外 +300；
 * 3. 大小写由调用方统一规范，这里只做字面比较，避免各处对大小写理解不同。
 */

/** 子串命中的基准分。 */
const SUBSTRING_BASE = 1000;
/** 子序列命中的基准分；恒低于任何子串命中。 */
const SUBSEQUENCE_BASE = 500;
/** 子串起点在词首的加分。 */
const BOUNDARY_BONUS = 300;

/**
 * 子序列命中的首尾跨度。
 *
 * @param haystack 被搜索文本。
 * @param needle 查询文本；逐字符贪心匹配。
 * @returns 首个字符到末个字符的跨度；未命中或空查询返回 `null`。
 */
export function subsequenceSpan(haystack: string, needle: string): number | null {
  let from = 0;
  let start = -1;
  let end = -1;
  for (const ch of needle) {
    const at = haystack.indexOf(ch, from);
    if (at < 0) return null;
    if (start < 0) start = at;
    end = at + 1;
    from = at + 1;
  }
  return start < 0 ? null : end - start;
}

/**
 * 查询在文本中的得分。
 *
 * @param needle 已规范化的非空查询。
 * @param haystack 已规范化的被搜索文本。
 * @param boundaries 视为词首分隔符的字符集合；空串表示只有文本开头算词首。
 * @returns 得分越高越好；子串与子序列都未命中时返回 `null`。
 */
export function fuzzyScore(needle: string, haystack: string, boundaries = ""): number | null {
  const at = haystack.indexOf(needle);
  if (at >= 0) {
    const boundary = at === 0 || boundaries.includes(haystack[at - 1] ?? "");
    return SUBSTRING_BASE - at + (boundary ? BOUNDARY_BONUS : 0);
  }
  const span = subsequenceSpan(haystack, needle);
  return span === null ? null : SUBSEQUENCE_BASE - span;
}

/**
 * 按多个匹配键的最高分排序条目。
 *
 * @param query 用户输入；首尾空白忽略，大小写不敏感。
 * @param items 候选条目；空查询时保持此顺序。
 * @param keys 每个条目参与匹配的文本（如文件名、路径、别名）。
 * @param limit 返回条目上限。
 * @param boundaries 词首分隔符，见 {@link fuzzyScore}。
 * @returns 命中条目，分数降序；同分保持输入顺序。
 */
export function rankByFuzzy<T>(
  query: string,
  items: readonly T[],
  keys: (item: T) => readonly string[],
  limit: number,
  boundaries = "",
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items.slice(0, limit);
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    let best: number | null = null;
    for (const key of keys(item)) {
      const score = fuzzyScore(needle, key.toLowerCase(), boundaries);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best !== null) scored.push({ item, score: best, index });
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.slice(0, limit).map(({ item }) => item);
}
