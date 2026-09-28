/**
 * frontmatter 的行模型与外科编辑。
 *
 * YAML 块是事实源，属性面板只是视图：改值只替换对应行的值段，删键只删
 * 该键的行区间，增键在闭合围栏前插一行——注释、顺序与未触碰行逐字节保留。
 * 块级结构（嵌套映射/块序列/块标量）不做行内编辑，交给源码模式，
 * 避免面板重排用户手写的 YAML。
 *
 * 已知边界：删除最后一个键会移除整个 frontmatter 块（包括块内的游离注释）；
 * 编辑过的行按「键: 值 注释」单空格规范重写，未触碰的行保持原字节。
 */

import type { Node as PmNode } from "prosemirror-model";

/** 面板里的一条属性。 */
export type FrontmatterEntry = {
  /** 顶层键原文。 */
  key: string;
  /** 展示值：标量/流式序列去引号与尾注释后的文本；块级结构为空串。 */
  value: string;
  /** 可行内编辑；块级结构为 false，面板提示走源码模式。 */
  editable: boolean;
};

/** 解析出的内部行模型。 */
type Model = {
  /** 全部行（含首尾围栏）。 */
  lines: string[];
  /** 闭合围栏的行号。 */
  fenceEnd: number;
  entries: Array<{
    key: string;
    value: string;
    editable: boolean;
    /** 键所在行号。 */
    start: number;
    /** 行区间终点（不含）：块级结构覆盖其缩进延续行。 */
    end: number;
    /** 行尾注释（`#` 起，不含前导空白）；写回时以单空格拼回。 */
    comment: string;
  }>;
};

/**
 * 找到文档的 YAML frontmatter 块。
 *
 * @param doc 当前文档。
 * @returns 首个子节点是 `---` 开头的源码保留块时给出位置与文本；否则 `null`。
 */
export function frontmatterBlock(doc: PmNode): { pos: number; size: number; text: string } | null {
  const first = doc.child(0);
  if (first.type.name !== "markdown_block") return null;
  const text = first.textContent;
  if (!text.startsWith("---")) return null;
  return { pos: 0, size: first.nodeSize, text };
}

/** 解析 frontmatter 文本为面板条目；不是合法 YAML 块时返回空列表。 */
export function frontmatterEntries(text: string): FrontmatterEntry[] {
  const model = parseModel(text);
  if (model === undefined) return [];
  return model.entries.map(({ key, value, editable }) => ({ key, value, editable }));
}

/**
 * 替换一个键的值；行尾注释、行尾 `\r`（CRLF 文件的混合形态）与其余行
 * 逐字节保留。
 *
 * @returns 编辑后的完整 frontmatter 文本；键不存在或不可行内编辑时为 `null`。
 */
export function setEntryValue(text: string, key: string, value: string): string | null {
  const model = parseModel(text);
  const entry = model?.entries.find((item) => item.key === key);
  if (model === undefined || entry === undefined || !entry.editable) return null;
  const lines = [...model.lines];
  const original = lines[entry.start] ?? "";
  lines[entry.start] = composeLine(key, value, entry.comment) + crOf(original);
  return lines.join("\n");
}

/**
 * 删除一个键（含其块级延续行）。
 *
 * @returns 编辑后的文本；删的是最后一个键时返回空串，调用方应移除整个
 * frontmatter 块。键不存在时为 `null`。
 */
export function removeEntry(text: string, key: string): string | null {
  const model = parseModel(text);
  const entry = model?.entries.find((item) => item.key === key);
  if (model === undefined || entry === undefined) return null;
  if (model.entries.length === 1) return "";
  const lines = [...model.lines.slice(0, entry.start), ...model.lines.slice(entry.end)];
  // CRLF 文件里「最后一个内容行」不带 \r（闭合围栏联接是 \n）；
  // 删除末位键后，新的最后内容行必须交出它的 \r，保持解析形态。
  normalizeLastContentLine(lines);
  return lines.join("\n");
}

/**
 * 追加一个新键。
 *
 * @param text 现有 frontmatter 文本；`null` 表示文档还没有 frontmatter，
 * 生成一个新的 YAML 块（新块用 `\n`，保存时由局部重写统一为文件换行）。
 * @returns 编辑后的文本；键名非法或已存在时为 `null`。
 */
export function addEntry(text: string | null, key: string, value: string): string | null {
  const trimmedKey = key.trim();
  if (!validKey(trimmedKey)) return null;
  const line = composeLine(trimmedKey, value, "");
  if (text === null) return `---\n${line}\n---`;
  const model = parseModel(text);
  if (model === undefined) return null;
  if (model.entries.some((entry) => entry.key === trimmedKey)) return null;
  const lines = [...model.lines];
  // CRLF 文件：原最后内容行升级为中间行要补回 \r；新行成为最后内容行，
  // 不带 \r——与「解析产物」的混合形态逐字节一致，保住保存往返校验。
  const crlf = (lines[model.fenceEnd - 1] ?? "").endsWith("\r") || isCrlfModel(lines);
  if (crlf) {
    const last = model.fenceEnd - 1;
    const lastLine = lines[last] ?? "";
    if (lastLine !== "" && !lastLine.endsWith("\r")) lines[last] = `${lastLine}\r`;
  }
  lines.splice(model.fenceEnd, 0, line);
  return lines.join("\n");
}

/** 行尾 `\r`（CRLF 文件内部行）；LF 行为空串。 */
function crOf(line: string): string {
  return line.endsWith("\r") ? "\r" : "";
}

/** 内容行里存在 `\r` 即视为 CRLF 形态。 */
function isCrlfModel(lines: readonly string[]): boolean {
  return lines.slice(1).some((line) => line.endsWith("\r"));
}

/** 闭合围栏前的最后一个内容行不带 `\r`；多余的去掉。 */
function normalizeLastContentLine(lines: string[]): void {
  for (let index = lines.length - 2; index >= 1; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "---") continue;
    if (line.endsWith("\r")) lines[index] = line.slice(0, -1);
    return;
  }
}

/** `键: 值 注释`；值经 YAML 安全渲染，注释为空时不追加分隔空格。 */
function composeLine(key: string, value: string, comment: string): string {
  const rendered = renderValue(value.trim());
  const base = `${key}: ${rendered}`;
  return comment === "" ? base : `${base} ${comment}`;
}

/** 键名：非空、不含冒号与首尾空白、不以 YAML 指示符开头。 */
function validKey(key: string): boolean {
  if (key === "" || key !== key.trim() || key.includes(":")) return false;
  return !/^[-?:,[\]{}#&*!|>'"%@`]/u.test(key);
}

/** 值渲染：仅在 YAML 需要时加双引号，避免改变用户数据的字面形态。 */
function renderValue(value: string): string {
  if (value === "") return '""';
  const needsQuotes =
    /^\s/u.test(value) ||
    /\s$/u.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/u.test(value) ||
    value.includes(": ") ||
    value.includes(" #") ||
    value.includes("\n");
  if (!needsQuotes) return value;
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function parseModel(text: string): Model | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  let fenceEnd = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      fenceEnd = index;
      break;
    }
  }
  if (fenceEnd < 0) return undefined;
  const entries: Model["entries"] = [];
  let index = 1;
  while (index < fenceEnd) {
    const line = lines[index] ?? "";
    // 顶层键行：不以空白/列表符/注释开头，取首个冒号分段。
    // 不锚定行尾：CRLF 文件的行以 \r 结束，`.` 不匹配 \r，值段自然停在 \r 前。
    const match = /^([^\s#-][^:]*):(.*)/u.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }
    const key = (match[1] ?? "").trim();
    const rest = match[2] ?? "";
    if (rest.trim() === "") {
      // 值为空：吞掉后续缩进/列表行；确有延续行才是块级结构，
      // 否则是 null 值键，仍可编辑。
      let end = index + 1;
      while (end < fenceEnd) {
        const next = lines[end] ?? "";
        if (next.trim() === "" || /^(\s|\s*-)/u.test(next)) end += 1;
        else break;
      }
      while (end - 1 > index && (lines[end - 1] ?? "").trim() === "") end -= 1;
      if (end > index + 1) {
        entries.push({ key, value: "", editable: false, start: index, end, comment: "" });
      } else {
        entries.push({ key, value: "", editable: true, start: index, end, comment: "" });
      }
      index = end;
      continue;
    }
    const { value, comment } = splitScalar(rest);
    entries.push({ key, value, editable: true, start: index, end: index + 1, comment });
    index += 1;
  }
  return { lines, fenceEnd, entries };
}

/** 拆出行内标量/流式值与尾注释；引号内的 `#` 与 `:` 属于值。 */
function splitScalar(rest: string): { value: string; comment: string } {
  const trimmed = rest.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    for (let index = 1; index < trimmed.length; index += 1) {
      const ch = trimmed[index];
      if (quote === '"' && ch === "\\") {
        index += 1;
        continue;
      }
      if (ch === quote) {
        const inner = trimmed.slice(1, index);
        const value = quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
        const tail = trimmed.slice(index + 1).trim();
        return { value, comment: tail.startsWith("#") ? tail : "" };
      }
    }
    // 引号未闭合：按字面处理，不猜用户意图。
    return { value: trimmed, comment: "" };
  }
  const at = searchCommentStart(trimmed);
  if (at < 0) return { value: trimmed, comment: "" };
  return { value: trimmed.slice(0, at).trimEnd(), comment: trimmed.slice(at).trimEnd() };
}

/** 值外第一个 ` #` 注释起点；流式序列 `[`…`]` 内的 `#` 属于值。 */
function searchCommentStart(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "[") depth += 1;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "#" && depth === 0 && index > 0 && /\s/u.test(text[index - 1] ?? ""))
      return index;
  }
  return -1;
}
