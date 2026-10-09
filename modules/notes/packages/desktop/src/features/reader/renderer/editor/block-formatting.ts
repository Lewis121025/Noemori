import { Fragment, NodeRange, Slice, type Node as PmNode } from "prosemirror-model";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { wrapRangeInList } from "prosemirror-schema-list";
import {
  canJoin,
  canSplit,
  findWrapping,
  liftTarget,
  ReplaceAroundStep,
} from "prosemirror-transform";
import { editingCommand } from "./read-only";
import { isListOrder } from "../../shared/markdown/schema";

/** 菜单提供的三种互斥列表格式；任务格式由列表项的 checked 属性承载。 */
export type ListFormat = "bullet" | "ordered" | "task";

/** 完整操作范围的格式状态；mixed 表示选中块的格式不一致。 */
export type BlockFormattingState = {
  list: ListFormat | "mixed" | null;
  quote: boolean | "mixed";
};

function isList(node: PmNode): boolean {
  return node.type.name === "bullet_list" || node.type.name === "ordered_list";
}

function selectionRange(state: EditorState, mode: "list" | "quote"): NodeRange | null {
  const { $from, empty } = state.selection;
  let { $to } = state.selection;
  // 选区终点落在下一段开头时，那一段没有被选中。
  if (!empty && $to.parent.isTextblock && $to.parentOffset === 0 && $to.before() > $from.pos) {
    let boundary = $to.before();
    for (let depth = $to.depth - 1; depth > 0 && boundary === $to.start(depth); depth--)
      boundary = $to.before(depth);
    $to = state.doc.resolve(boundary);
  }
  if (mode === "quote") {
    const quoted = $from.blockRange($to, (node) => node.type.name === "blockquote");
    if (quoted) return quoted;
  } else {
    // 列表项是完整操作单元；它的引用和子列表不能让命令转而修改另一层列表。
    for (let depth = $from.depth; depth > 1; depth--)
      if ($from.node(depth).type.name === "list_item" && $to.pos <= $from.end(depth - 1))
        return new NodeRange($from, $to, depth - 1);
  }
  return $from.blockRange($to);
}

function flatRange(doc: PmNode, from: number, to: number, depth: number): NodeRange {
  return new NodeRange(doc.resolve(from), doc.resolve(to), depth);
}

function ranges(state: EditorState, mode: "list" | "quote"): NodeRange[] {
  const root = selectionRange(state, mode);
  if (!root) return [];
  const result: NodeRange[] = [];
  const collect = (range: NodeRange): void => {
    if (
      (mode === "list" && isList(range.parent)) ||
      (mode === "quote" && range.parent.type.name === "blockquote")
    ) {
      result.push(range);
      return;
    }
    let position = range.start;
    let start = position;
    for (let index = range.startIndex; index < range.endIndex; index++) {
      const child = range.parent.child(index);
      const end = position + child.nodeSize;
      if (child.type.name === "blockquote" || (mode === "list" && isList(child))) {
        if (start < position) result.push(flatRange(state.doc, start, position, range.depth));
        collect(
          flatRange(
            state.doc,
            Math.max(range.$from.pos, position + 1),
            Math.min(range.$to.pos, end - 1),
            range.depth + 1,
          ),
        );
        start = end;
      }
      position = end;
    }
    if (start < position) result.push(flatRange(state.doc, start, position, range.depth));
  };
  collect(root);
  return result;
}

function listState(groups: readonly NodeRange[]): BlockFormattingState["list"] {
  const formats = new Set<ListFormat | null>();
  for (const range of groups) {
    if (!isList(range.parent)) formats.add(null);
    else
      for (let index = range.startIndex; index < range.endIndex; index++) {
        const checked: unknown = range.parent.child(index).attrs["checked"];
        formats.add(
          typeof checked === "boolean"
            ? "task"
            : range.parent.type.name === "ordered_list"
              ? "ordered"
              : "bullet",
        );
      }
  }
  return formats.size > 1 ? "mixed" : (formats.values().next().value ?? null);
}

/**
 * 读取列表类型和引用状态，范围与命令一致，避免只看选区起点产生误导。
 * @param state 所属编辑器当前状态。
 * @returns 统一格式或混合状态；不可定位的选区返回未应用，不创建事务，不抛出异常。
 */
export function readBlockFormatting(state: EditorState): BlockFormattingState {
  const quoted = ranges(state, "quote").map((range) => range.parent.type.name === "blockquote");
  return {
    list: listState(ranges(state, "list")),
    quote: quoted.some(Boolean) ? (quoted.every(Boolean) ? true : "mixed") : false,
  };
}

function mappedRange(tr: Transaction, range: NodeRange): NodeRange {
  return flatRange(
    tr.doc,
    tr.mapping.map(range.start, 1),
    tr.mapping.map(range.end, -1),
    range.depth,
  );
}

function listAttrs(list: PmNode, index: number): PmNode["attrs"] {
  return list.type.name === "ordered_list"
    ? { ...list.attrs, order: Number(list.attrs["order"]) + index }
    : list.attrs;
}

function canRemoveList(range: NodeRange): boolean {
  const list = range.parent;
  let content = Fragment.empty;
  if (range.startIndex > 0)
    content = content.append(
      Fragment.from(list.copy(Fragment.fromArray(list.content.content.slice(0, range.startIndex)))),
    );
  for (let index = range.startIndex; index < range.endIndex; index++)
    content = content.append(list.child(index).content);
  if (range.endIndex < list.childCount)
    content = content.append(
      Fragment.from(
        list.type.create(
          listAttrs(list, range.endIndex),
          list.content.content.slice(range.endIndex),
        ),
      ),
    );
  const $list = range.$from.doc.resolve(range.$from.before(range.depth));
  return $list.parent.canReplace($list.index(), $list.index() + 1, content);
}

function isolateList(tr: Transaction, range: NodeRange): number {
  const startStep = tr.steps.length;
  const list = range.parent;
  // 先切右边再切左边；未选中的编号列表继续使用原有序号。
  if (range.endIndex < list.childCount)
    tr.split(range.end, 1, [{ type: list.type, attrs: listAttrs(list, range.endIndex) }]);
  if (range.startIndex > 0)
    tr.split(range.start, 1, [{ type: list.type, attrs: listAttrs(list, range.startIndex) }]);
  return tr.mapping.slice(startStep).map(range.start, 1) - 1;
}

function removeList(tr: Transaction, position: number): void {
  const list = tr.doc.nodeAt(position)!;
  let end = position + 1 + list.content.size;
  // 合并列表项的内容后只移除容器；保留内容间隙的映射，选区和撤销不丢失。
  for (let index = list.childCount - 1; index > 0; index--) {
    end -= list.child(index).nodeSize;
    tr.delete(end - 1, end + 1);
  }
  const merged = tr.doc.nodeAt(position)!;
  tr.step(
    new ReplaceAroundStep(
      position,
      position + merged.nodeSize,
      position + 2,
      position + merged.nodeSize - 2,
      Slice.empty,
      0,
      true,
    ),
  );
}

function formatItems(tr: Transaction, range: NodeRange, kind: ListFormat): void {
  let position = range.start;
  for (let index = range.startIndex; index < range.endIndex; index++) {
    const item = range.parent.child(index);
    const previous: unknown = item.attrs["checked"];
    const checked = kind === "task" ? (typeof previous === "boolean" ? previous : false) : null;
    if (checked !== previous) tr.setNodeMarkup(position, undefined, { ...item.attrs, checked });
    position += item.nodeSize;
  }
}

function formatListRange(tr: Transaction, range: NodeRange, kind: ListFormat): number {
  const type = tr.doc.type.schema.nodes[kind === "ordered" ? "ordered_list" : "bullet_list"]!;
  let items = range;
  if (!isList(range.parent)) {
    const startStep = tr.steps.length;
    wrapRangeInList(tr, range, type);
    const position = tr.mapping.slice(startStep).map(range.start, -1);
    const list = tr.doc.nodeAt(position)!;
    items = flatRange(tr.doc, position + 1, position + list.nodeSize - 1, range.depth + 1);
  } else if (range.parent.type !== type) {
    const position = isolateList(tr, range);
    const list = tr.doc.nodeAt(position)!;
    tr.setNodeMarkup(position, type, { ...list.attrs, order: 1 });
    items = flatRange(tr.doc, position + 1, position + list.nodeSize - 1, range.depth);
  }
  formatItems(tr, items, kind);
  return items.$from.before(items.depth);
}

function joinFormattedLists(tr: Transaction, points: { position: number; step: number }[]): void {
  const positions = new Set(
    points.map(({ position, step }) => tr.mapping.slice(step).map(position)),
  );
  // 同一次操作里的相邻列表形成连续条目；否则 Markdown 会把独立重编号的容器读成另一结构。
  for (const position of [...positions].sort((left, right) => right - left)) {
    const left = tr.doc.resolve(position).nodeBefore;
    const right = tr.doc.nodeAt(position);
    if (
      left &&
      right &&
      left.type === right.type &&
      positions.has(position - left.nodeSize) &&
      canJoin(tr.doc, position)
    )
      tr.join(position);
  }
}

/**
 * 切换选中的完整列表项或段落；仅有光标时只操作当前项。
 * @param kind 目标格式；混合选区先统一应用，全体一致时取消为段落。
 * @returns 权限受控的命令；不兼容的选区整次拒绝，查询不创建事务。
 * @throws 事务模型异常继续抛出；不会丢弃内容或降级为部分成功。
 */
export function listFormattingCommand(kind: ListFormat): Command {
  return editingCommand((state, dispatch) => {
    const groups = ranges(state, "list");
    if (groups.length === 0) return false;
    const remove = listState(groups) === kind;
    const type = state.schema.nodes[kind === "ordered" ? "ordered_list" : "bullet_list"]!;
    for (const range of groups) {
      if (!isList(range.parent)) {
        if (!wrapRangeInList(null, range, type)) return false;
      } else if (remove || range.parent.type !== type) {
        if (
          range.parent.type.name === "ordered_list" &&
          [range.startIndex, range.endIndex].some(
            (index) =>
              index > 0 &&
              index < range.parent.childCount &&
              !isListOrder(Number(range.parent.attrs["order"]) + index),
          )
        )
          return false;
        if (remove && !canRemoveList(range)) return false;
        if (range.startIndex > 0 && !canSplit(state.doc, range.start)) return false;
        if (range.endIndex < range.parent.childCount && !canSplit(state.doc, range.end))
          return false;
      }
    }
    if (!dispatch) return true;
    const tr = state.tr;
    const points: { position: number; step: number }[] = [];
    for (const original of groups.toReversed()) {
      const range = mappedRange(tr, original);
      if (remove) {
        removeList(tr, isolateList(tr, range));
      } else {
        const position = formatListRange(tr, range, kind);
        points.push({ position, step: tr.steps.length });
      }
    }
    if (!remove) joinFormattedLists(tr, points);
    tr.setSelection(state.selection.getBookmark().map(tr.mapping).resolve(tr.doc));
    if (state.storedMarks) tr.setStoredMarks(state.storedMarks);
    dispatch(tr.scrollIntoView());
    return true;
  });
}

/**
 * 混合选区只给未引用块添加引用；统一引用时取消当前引用层，保留内部列表。
 * @returns 权限受控的命令；结构不允许时整次拒绝，查询不创建事务。
 * @throws 事务模型异常继续抛出，不额外嵌套已有引用或执行部分操作。
 */
export const quoteFormattingCommand: Command = editingCommand((state, dispatch) => {
  const groups = ranges(state, "quote");
  if (groups.length === 0) return false;
  const remove = groups.every((range) => range.parent.type.name === "blockquote");
  const type = state.schema.nodes["blockquote"]!;
  for (const range of groups) {
    if (remove) {
      if (liftTarget(range) !== range.depth - 1) return false;
    } else if (range.parent.type !== type && !findWrapping(range, type)) return false;
  }
  if (!dispatch) return true;
  const tr = state.tr;
  for (const original of groups.toReversed()) {
    const range = mappedRange(tr, original);
    if (remove) tr.lift(range, range.depth - 1);
    else if (range.parent.type !== type) tr.wrap(range, [{ type }]);
  }
  tr.setSelection(state.selection.getBookmark().map(tr.mapping).resolve(tr.doc));
  if (state.storedMarks) tr.setStoredMarks(state.storedMarks);
  dispatch(tr.scrollIntoView());
  return true;
});
