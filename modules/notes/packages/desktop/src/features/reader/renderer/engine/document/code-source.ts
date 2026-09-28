import type { ChangeSet } from "@codemirror/state";

/**
 * 把 CodeMirror 事务应用到原始文本，只替换修改区间，保留其他行的 CRLF/LF/CR。
 * @param source 事务之前的完整源码，包含 BOM。
 * @param changes 对应规范化换行后文档的有序修改。
 * @returns 供保存的完整源码；新增行沿用文件第一次出现的换行方式。
 * @throws 文档长度或位置不匹配时抛错，禁止把旧事务应用到另一版本。
 */
export function applyCodeChanges(source: string, changes: ChangeSet): string {
  let position = 0;
  let offset = 0;
  function sourceOffset(target: number): number {
    while (position < target && offset < source.length) {
      if (source[offset] === "\r" && source[offset + 1] === "\n") offset++;
      offset++;
      position++;
    }
    if (position !== target) throw new Error("文本修改位置越界");
    return offset;
  }
  const newline = /\r\n|\r|\n/.exec(source)?.[0] ?? "\n";
  let result = "";
  let end = 0;
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const start = sourceOffset(from);
    const next = sourceOffset(to);
    result += source.slice(end, start) + inserted.sliceString(0, inserted.length, newline);
    end = next;
  });
  if (sourceOffset(changes.length) !== source.length)
    throw new Error("文本源码与编辑事务的版本不一致");
  return result + source.slice(end);
}
