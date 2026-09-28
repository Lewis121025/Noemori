import type { Node as PmNode } from "prosemirror-model";
import type { SourceNode } from "./source-map";
import { serializeMarkdown } from "./serialize";
import { sourceLinePrefix } from "./source-text";

/**
 * 更新表格源码：按编辑器复用的节点识别行列，仅生成新增的单元格和对齐标记。
 * @param source 初始完整源码，范围来自同一次解析。
 * @param previous 初始表格及其源范围。
 * @param current 当前表格，首行为表头。
 * @param renderCell 已配对单元格的局部文字渲染入口。
 * @returns 表格片段，不包含文件末尾换行；无法确认表头或分隔行时抛错。
 */
export function renderTableSource(
  source: string,
  previous: SourceNode,
  current: PmNode,
  renderCell: (before: SourceNode, after: PmNode) => string,
): string {
  const header = previous.children[0];
  if (header === undefined || current.firstChild === null) throw new Error("表格缺少源码表头");
  const prefix = sourceLinePrefix(source, previous.start).replace(/[^\s>]/g, " ");
  const gap = source.slice(header.end, previous.children[1]?.start ?? previous.end);
  const newline = gap.startsWith("\r\n") ? "\r\n" : "\n";
  const separator = newline + prefix;
  const lastBreak = gap.lastIndexOf("\n");
  const delimiterEnd =
    previous.children[1] === undefined
      ? gap.length
      : lastBreak - (gap[lastBreak - 1] === "\r" ? 1 : 0);
  const bodySeparator = previous.children[1] === undefined ? separator : gap.slice(delimiterEnd);
  const delimiter = gap.slice(separator.length, delimiterEnd);
  const delimiters = cellParts(delimiter);
  if (
    delimiters.length !== header.node.childCount ||
    delimiters.some((part) => !/^\s*:?-+:?\s*$/.test(part))
  )
    throw new Error("无法确认表格的列分隔范围，编辑已保留");
  const origins = rowOrigins(previous.children, current);
  const columns = columnOrigins(previous.children, current, origins);
  const rows = current.content.content.map((row, index) => {
    const before = previous.children[origins[index] ?? -1];
    if (before?.node.eq(row)) return source.slice(before.start, before.end);
    const cells = row.content.content.map((cell, column) => {
      const original = before?.children[columns[column] ?? -1];
      if (original === undefined) return ` ${cellText(cell)} `;
      const raw = original.node.content.eq(cell.content)
        ? source.slice(original.start, original.end)
        : // 对齐由分隔行承担；文字局部更新使用原单元格属性，避免无关格式被重写。
          renderCell(original, cell.type.create(original.node.attrs, cell.content, cell.marks));
      const part = cellParts(raw)[0];
      if (part === undefined) throw new Error("无法确认单元格的源码范围");
      return part;
    });
    const raw = before === undefined ? "||" : source.slice(before.start, before.end);
    return joinCells(cells, raw);
  });
  const divider = current.child(0).content.content.map((cell, column) => {
    const original = columns[column];
    const hasDelimiter = original != null && original < header.node.childCount;
    const raw = hasDelimiter ? delimiters[original] : " --- ";
    if (raw === undefined) throw new Error("表格列分隔符不存在");
    const align = cell.attrs["align"];
    const beforeAlign = hasDelimiter ? header.node.child(original).attrs["align"] : null;
    if (align === beforeAlign) return raw;
    return raw.replace(/:?-+:?/, (marker) => {
      const dashes = marker.replace(/:/g, "");
      return `${align === "left" || align === "center" ? ":" : ""}${dashes}${align === "right" || align === "center" ? ":" : ""}`;
    });
  });
  const alignment = joinCells(divider, delimiter);
  const first = rows[0];
  if (first === undefined) throw new Error("表格没有表头");
  let result = first + separator + alignment;
  for (let index = 1; index < rows.length; index++) {
    const before = previous.children[origins[index - 1] ?? -1];
    const after = previous.children[origins[index] ?? -1];
    const adjacent =
      index > 1 &&
      before !== undefined &&
      after !== undefined &&
      origins[index] === (origins[index - 1] ?? -2) + 1;
    result +=
      (index === 1 ? bodySeparator : adjacent ? source.slice(before.end, after.start) : separator) +
      rows[index];
  }
  return result;
}

function rowOrigins(previous: SourceNode[], current: PmNode): Array<number | null> {
  const used = new Set<number>([0]);
  const origins: Array<number | null> = Array.from({ length: current.childCount }, () => null);
  origins[0] = 0;
  // 新增空行与旧空行可以值相等；先保留所有节点身份，防止旧行的排版被挪用。
  for (let index = 1; index < current.childCount; index++) {
    const match = previous.findIndex(
      (item, at) => !used.has(at) && item.node === current.child(index),
    );
    if (match >= 0) {
      origins[index] = match;
      used.add(match);
    }
  }
  for (let index = 1; index < current.childCount; index++) {
    if (origins[index] !== null) continue;
    const row = current.child(index);
    let match = previous.findIndex((item, at) => !used.has(at) && item.node.eq(row));
    if (match < 0) {
      const shared = previous
        .map((item, at) => ({ item, at }))
        .filter(
          ({ item, at }) =>
            !used.has(at) &&
            item.node.content.content.some((cell) => row.content.content.includes(cell)),
        );
      if (shared.length === 1) match = shared[0]?.at ?? -1;
    }
    if (match < 0 && previous.length === current.childCount && !used.has(index)) match = index;
    origins[index] = match < 0 ? null : match;
    if (match >= 0) used.add(match);
  }
  return origins;
}

function columnOrigins(
  previous: SourceNode[],
  current: PmNode,
  rows: Array<number | null>,
): Array<number | null> {
  const header = current.child(0);
  const used = new Set<number>();
  const result: Array<number | null> = Array.from({ length: header.childCount }, () => null);
  // 先锁定所有仍共享身份的列，新增空白单元格不能先通过值相等抢走旧列。
  for (let column = 0; column < header.childCount; column++) {
    const candidates = new Set<number>();
    current.forEach((row, _offset, index) => {
      const old = previous[rows[index] ?? -1];
      const cell = row.maybeChild(column);
      old?.node.forEach((original, _at, candidate) => {
        if (original === cell) candidates.add(candidate);
      });
    });
    if (candidates.size === 1) {
      const candidate = [...candidates][0];
      if (candidate !== undefined && !used.has(candidate)) {
        result[column] = candidate;
        used.add(candidate);
      }
    }
  }
  const oldHeader = previous[0];
  if (oldHeader === undefined) return result;
  for (let column = 0; column < header.childCount; column++) {
    if (result[column] !== null) continue;
    const matches = oldHeader.children
      .map((cell, at) => ({ cell, at }))
      .filter(
        ({ cell, at }) => !used.has(at) && cell.node.content.eq(header.child(column).content),
      );
    const match =
      matches.length === 1
        ? matches[0]?.at
        : header.childCount === oldHeader.node.childCount && !used.has(column)
          ? column
          : undefined;
    if (match !== undefined) {
      result[column] = match;
      used.add(match);
    }
  }
  return result;
}

function endsWithDelimiter(source: string): boolean {
  const text = source.trimEnd();
  // 空单元格的源范围可能只有起始竖线与空格，不能把同一竖线再当作尾边框。
  if (text.length < 2 || !text.endsWith("|")) return false;
  let escapes = 0;
  for (let index = text.length - 2; index >= 0 && text[index] === "\\"; index--) escapes++;
  return escapes % 2 === 0;
}

function joinCells(cells: string[], original: string): string {
  // 原文可省略边缘竖线；单列必须显式加边框，边框外的行尾空格仍原样保留。
  const leading = original.startsWith("|") || cells.length === 1 ? "|" : "";
  const trailing = endsWithDelimiter(original)
    ? "|" + original.slice(original.trimEnd().length)
    : cells.length === 1
      ? "|"
      : "";
  return leading + cells.join("|") + trailing;
}

function cellParts(source: string): string[] {
  const text = source.slice(
    source.startsWith("|") ? 1 : 0,
    endsWithDelimiter(source) ? source.trimEnd().length - 1 : undefined,
  );
  const parts: string[] = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "|" && !escaped) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    escaped = character === "\\" && !escaped;
  }
  parts.push(text.slice(start));
  return parts;
}

function cellText(cell: PmNode): string {
  const schema = cell.type.schema;
  const table = schema.node(
    "table",
    null,
    schema.node("table_row", null, schema.node("table_header", cell.attrs, cell.content)),
  );
  const line = serializeMarkdown(schema.node("doc", null, table)).split("\n")[0];
  if (line === undefined) throw new Error("无法生成新单元格");
  const content = cellParts(line)[0];
  if (content === undefined) throw new Error("新单元格缺少内容范围");
  return content.trim();
}
