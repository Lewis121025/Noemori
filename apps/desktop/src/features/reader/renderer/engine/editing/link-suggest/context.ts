/**
 * 内联补全的触发上下文：从光标前的连续文本运行里识别 `[[` 与 `](`。
 *
 * 只在文本节点内触发：代码块、源码保留块与行内代码里输入链接语法是字面
 * 文本，不弹补全。锚点模式复用同一识别——查询里出现 `#` 后，`#` 之后的
 * 部分成为标题查询（`#^` 之后是块查询），之前的部分成为待解析的目标。
 */

import type { Node as PmNode } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import type { LinkKind } from "../../../../shared/api";

/** 内联补全请求；`from` 是查询文本起点（替换范围到当前光标）。 */
export type SuggestRequest =
  | {
      kind: "file";
      syntax: LinkKind;
      from: number;
      /** 触发串（`[[` / `](`）的绝对起点；wiki 补全连触发一起替换。 */
      triggerFrom: number;
      query: string;
      /** 光标后已有闭合语法时一并消费 `]]`/`)`，保证插入结果是干净链接。 */
      closeAfter: boolean;
      /** md 语法时标签 `[` 的绝对位置；wiki 或找不到配对时为 `null`。 */
      labelStart: number | null;
    }
  | {
      /** `#` 之后是标题查询；`#^` 之后是块查询。 */
      kind: "heading" | "block";
      syntax: LinkKind;
      from: number;
      /** 触发串（`[[` / `](`）的绝对起点；wiki 补全连触发一起替换。 */
      triggerFrom: number;
      query: string;
      /** `#` 之前的目标原文，交给调用方解析成文件后取标题或块；空串表示本笔记。 */
      target: string;
      closeAfter: boolean;
      /** md 语法时标签 `[` 的绝对位置；wiki 或找不到配对时为 `null`。 */
      labelStart: number | null;
    };

/** 不触发补全的文本块：代码与源码保留节点的语法是字面文本。 */
const NO_SUGGEST_BLOCKS = new Set(["code_block", "markdown_block"]);

/**
 * 计算当前光标处的补全请求。
 *
 * @param state 编辑器状态；选区必须为空光标。
 * @returns 触发中的请求；不在链接语法内时返回 `null`。
 */
export function suggestRequest(state: EditorState): SuggestRequest | null {
  const { $from, empty } = state.selection;
  if (!empty) return null;
  const parent = $from.parent;
  if (!parent.isTextblock || NO_SUGGEST_BLOCKS.has(parent.type.name)) return null;
  // 行内代码里的 [[ 是字面文本。
  if ($from.marks().some((mark) => mark.type.name === "code")) return null;

  const run = textRunBefore(state);
  const wiki = run.text.lastIndexOf("[[");
  const md = run.text.lastIndexOf("](");
  const trigger = Math.max(wiki, md);
  if (trigger < 0) return null;
  const syntax: LinkKind = wiki >= md ? "wiki" : "md";
  // 转义的 \[[ 是字面文本；反斜杠按奇偶判定，与扫描器同一规则。
  if (syntax === "wiki" && escapedTrigger(run.text, trigger)) return null;
  const query = run.text.slice(trigger + 2);
  // 语法已闭合说明光标在完成的链接之后，不再补全。
  if (query.includes(syntax === "wiki" ? "]]" : ")")) return null;
  // 外部 URL 不参与库内路径补全。
  if (syntax === "md" && query.includes("://")) return null;
  // wiki 别名段没有可补全目标。
  if (syntax === "wiki" && query.includes("|")) return null;

  const closeAfter = textAfterCursor(state).startsWith(syntax === "wiki" ? "]]" : ")");
  const labelStart = syntax === "md" ? findLabelStart(run.text, trigger, run.from) : null;
  const triggerFrom = run.from + trigger;
  const queryFrom = triggerFrom + 2;
  const hash = query.lastIndexOf("#");
  if (hash >= 0) {
    const block = query[hash + 1] === "^";
    return {
      kind: block ? "block" : "heading",
      syntax,
      from: queryFrom + hash + (block ? 2 : 1),
      triggerFrom,
      query: query.slice(hash + (block ? 2 : 1)),
      target: query.slice(0, hash),
      closeAfter,
      labelStart,
    };
  }
  return { kind: "file", syntax, from: queryFrom, triggerFrom, query, closeAfter, labelStart };
}

/**
 * 从 `](` 触发点向前找配对的标签 `[`（跳过嵌套的 `]…[` 对）。
 *
 * @returns 绝对位置；同一文本运行里没有配对时为 `null`，
 * 调用方退回纯文本插入，不伪造链接结构。
 */
function findLabelStart(text: string, trigger: number, base: number): number | null {
  let depth = 0;
  for (let index = trigger - 1; index >= 0; index -= 1) {
    const ch = text[index];
    if (ch === "]") depth += 1;
    else if (ch === "[") {
      if (depth === 0) return base + index;
      depth -= 1;
    }
  }
  return null;
}

/** 触发串前的连续反斜杠为奇数时，触发被转义。 */
function escapedTrigger(text: string, trigger: number): boolean {
  let count = 0;
  for (let index = trigger - 1; index >= 0 && text[index] === "\\"; index -= 1) count += 1;
  return count % 2 === 1;
}

/**
 * 光标前的连续文本运行：跨越相邻文本子节点（含不同 mark），
 * 遇到行内原子（wiki 链接、图片、公式）即停。
 *
 * @returns 运行文本与其在文档中的起点。
 */
function textRunBefore(state: EditorState): { text: string; from: number } {
  const { $from } = state.selection;
  const parent = $from.parent;
  const cursor = $from.parentOffset;
  const entries: Array<{ node: PmNode; start: number; end: number }> = [];
  parent.forEach((child, childOffset) => {
    entries.push({ node: child, start: childOffset, end: childOffset + child.nodeSize });
  });
  let text = "";
  let start = cursor;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.start >= cursor) continue;
    if (!entry.node.isText) break;
    const slice =
      entry.end <= cursor
        ? (entry.node.text ?? "")
        : (entry.node.text ?? "").slice(0, cursor - entry.start);
    text = slice + text;
    start = entry.start;
  }
  return { text, from: $from.pos - (cursor - start) };
}

/** 光标后同段落内的紧邻文本（最多 2 字符），用于判断闭合语法。 */
function textAfterCursor(state: EditorState): string {
  const { $from } = state.selection;
  const parent = $from.parent;
  const cursor = $from.parentOffset;
  const end = Math.min(cursor + 2, parent.content.size);
  if (end <= cursor) return "";
  return parent.textBetween(cursor, end, undefined, "\ufffc");
}
