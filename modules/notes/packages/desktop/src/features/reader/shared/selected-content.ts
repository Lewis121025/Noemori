import { isEntryPath } from "./file-browser";

/** 添加引用时捕获的文件来源；源码位置按 UTF-16 计，原文副本用于再次核对。 */
export type SelectionSource = {
  root: string;
  path: string;
  offset: number | null;
  sourceText: string;
};

/** 选区快照由阅读器发布；来源只用于导航，不授予文件访问权限。 */
export type SelectedContent = { id: string; text: string; source: SelectionSource | null };

/** 选区与文件拖拽采用独立协议，保留原文和来源身份。 */
export const SELECTED_CONTENT_MIME = "application/x-noemori-reference";
/** 选区与对话引用共享字节预算，接收方不得静默截断原文。 */
export const MAX_SELECTED_CONTENT_BYTES = 32 * 1024;

function parseSelectionSource(value: unknown): SelectionSource | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("root" in value) ||
    typeof value.root !== "string" ||
    !value.root.startsWith("/") ||
    value.root.includes("\0") ||
    !("path" in value) ||
    !isEntryPath(value.path) ||
    !("sourceText" in value) ||
    typeof value.sourceText !== "string" ||
    !value.sourceText.trim() ||
    !("offset" in value) ||
    (value.offset !== null &&
      (typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0))
  )
    throw new Error("引用来源无效");
  return { root: value.root, path: value.path, offset: value.offset, sourceText: value.sourceText };
}

/**
 * @param value 选区、拖拽或引用持久化中的未验证快照。
 * @returns 独立且保留换行与来源的内容，不修改原文。
 * @throws 身份、文字、来源非法或内容超过 32 KiB 时拒绝。
 */
export function parseSelectedContent(value: unknown): SelectedContent {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[\w-]{1,128}$/u.test(value.id) ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    /[\uD800-\uDFFF]/u.test(value.text) ||
    !("source" in value)
  )
    throw new Error("引用身份或文字无效");
  const selected = { id: value.id, text: value.text, source: parseSelectionSource(value.source) };
  if (new TextEncoder().encode(JSON.stringify([selected])).length > MAX_SELECTED_CONTENT_BYTES)
    throw new Error("引用内容超过 32 KiB，请缩小选区或移除部分引用");
  return selected;
}

/**
 * 核对旧位置，原文移动后只采用唯一命中；缺失或重复时明确拒绝。
 * @param source 当前完整源码。
 * @param location 添加引用时捕获的来源。
 * @returns 可选中的 UTF-16 区间，不修改文本。
 * @throws 原文已变化或无法唯一定位时拒绝，调用方仍可打开来源文件。
 */
export function referenceRange(
  source: string,
  location: SelectionSource,
): { from: number; to: number } {
  const { offset, sourceText } = location;
  if (offset !== null && source.slice(offset, offset + sourceText.length) === sourceText)
    return { from: offset, to: offset + sourceText.length };
  const first = source.indexOf(sourceText);
  if (first < 0 || source.indexOf(sourceText, first + 1) >= 0)
    throw new Error("来源已打开，但引用原文已变化或无法唯一定位");
  return { from: first, to: first + sourceText.length };
}
