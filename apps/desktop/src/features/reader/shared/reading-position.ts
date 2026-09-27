/** 每侧最多保存 64 个 UTF-16 单元；阅读现场不复制整篇文档。 */
export const READING_CONTEXT_LIMIT = 64;

/** 源码字符位置及其邻接文本；前文变化时用上下文重新定位。 */
export type SourcePoint = {
  offset: number;
  before: string;
  after: string;
};

/** 可跨表面、跨重启传递的阅读位置；inset 是锚点相对阅读区顶部的像素距离。 */
export type ReadingBookmark = {
  source: SourcePoint;
  inset: number;
};

/** 校验恢复性位置数据；损坏、越界或过大的上下文返回 null，不阻止打开文档。 */
export function parseReadingBookmark(value: unknown): ReadingBookmark | null {
  if (typeof value !== "object" || value === null || !("source" in value) || !("inset" in value))
    return null;
  const { source, inset } = value;
  if (
    typeof inset !== "number" ||
    !Number.isFinite(inset) ||
    Math.abs(inset) > 100_000 ||
    typeof source !== "object" ||
    source === null ||
    !("offset" in source) ||
    !("before" in source) ||
    !("after" in source)
  )
    return null;
  const { offset, before, after } = source;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof before !== "string" ||
    before.length > READING_CONTEXT_LIMIT ||
    typeof after !== "string" ||
    after.length > READING_CONTEXT_LIMIT
  )
    return null;
  return { source: { offset, before, after }, inset };
}
