import { READING_CONTEXT_LIMIT, type SourcePoint } from "../../shared/reading-position";

/** 将位置夹到源码字符边界；不把 emoji 的代理对从中间分开。 */
function characterBoundary(source: string, offset: number): number {
  const at = Math.max(0, Math.min(source.length, offset));
  return at > 0 &&
    /[\uDC00-\uDFFF]/.test(source.charAt(at)) &&
    /[\uD800-\uDBFF]/.test(source.charAt(at - 1))
    ? at - 1
    : at;
}

/** 从完整原文捕获有界上下文；offset 使用 UTF-16，非法数值抛出 RangeError。 */
export function captureSourcePoint(source: string, offset: number): SourcePoint {
  if (!Number.isSafeInteger(offset)) throw new RangeError("源码位置必须是安全整数");
  const at = characterBoundary(source, offset);
  return {
    offset: at,
    before: source.slice(Math.max(0, at - READING_CONTEXT_LIMIT), at),
    after: source.slice(at, at + READING_CONTEXT_LIMIT),
  };
}

/**
 * 在当前文本里恢复字符锚点；优先完整上下文，其次仍存留的一侧，最后夹到原偏移。
 * 重复文本取离原位置最近的命中，避免阅读现场跳到文首同名段落。
 */
export function resolveSourcePoint(source: string, point: SourcePoint): number {
  const { offset, before, after } = point;
  if (
    source.slice(Math.max(0, offset - before.length), offset) === before &&
    source.slice(offset, offset + after.length) === after
  )
    return characterBoundary(source, offset);
  function nearest(needle: string, shift: number): number | null {
    if (needle === "") return null;
    let result: number | null = null;
    let at = source.indexOf(needle);
    while (at !== -1) {
      const candidate = at + shift;
      if (result === null || Math.abs(candidate - offset) < Math.abs(result - offset))
        result = candidate;
      at = source.indexOf(needle, at + 1);
    }
    return result;
  }
  const matched =
    nearest(before + after, before.length) ??
    (after.length >= 8 ? nearest(after, 0) : null) ??
    (before.length >= 8 ? nearest(before, before.length) : null);
  return characterBoundary(source, matched ?? offset);
}
