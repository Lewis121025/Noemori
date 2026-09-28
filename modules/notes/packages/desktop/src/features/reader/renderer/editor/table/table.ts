import type { Node as PmNode } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";

type TableContext = { table: PmNode; position: number; row: number; column: number };
type TableAction =
  "addRow" | "deleteRow" | "addColumn" | "deleteColumn" | "left" | "center" | "right";

function context(state: EditorState): TableContext | null {
  const { $from, $to } = state.selection;
  if (!["table_cell", "table_header"].includes($from.parent.type.name)) return null;
  const depth = $from.depth - 2;
  if (depth < 1 || $from.node(depth).type.name !== "table" || $to.depth < depth) return null;
  if ($to.before(depth) !== $from.before(depth)) return null;
  return {
    table: $from.node(depth),
    position: $from.before(depth),
    row: $from.index(depth),
    column: $from.index(depth + 1),
  };
}

/** 当前选区属于同一张表格时显示结构操作；跨表格选区不会猜测操作目标。 */
export function inTable(state: EditorState): boolean {
  return context(state) !== null;
}

function rectangularRows(table: PmNode): PmNode[] {
  const width = Math.max(...table.content.content.map((row) => row.childCount));
  return table.content.content.map((row, index) =>
    row.childCount === width
      ? row
      : row.type.create(
          row.attrs,
          Array.from({ length: width }, (_, column) => {
            const cell = row.maybeChild(column);
            if (cell !== null) return cell;
            return table.type.schema.node(index === 0 ? "table_header" : "table_cell", {
              align: table.firstChild?.maybeChild(column)?.attrs["align"] ?? null,
            });
          }),
        ),
  );
}

function emptyRow(header: PmNode): PmNode {
  return header.type.create(
    null,
    header.content.content.map((cell) =>
      header.type.schema.node("table_cell", { align: cell.attrs["align"] }),
    ),
  );
}

function selectCell(
  transaction: Transaction,
  position: number,
  table: PmNode,
  row: number,
  column: number,
): Transaction {
  let at = position + 2;
  for (let index = 0; index < row; index++) at += table.child(index).nodeSize;
  for (let index = 0; index < column; index++) at += table.child(row).child(index).nodeSize;
  return transaction.setSelection(TextSelection.create(transaction.doc, at + 1)).scrollIntoView();
}

function change(action: TableAction): Command {
  return (state, dispatch) => {
    const location = context(state);
    if (location === null) return false;
    const { table, position, row, column } = location;
    const width = Math.max(...table.content.content.map((item) => item.childCount));
    if (action === "deleteRow" && row === 0) return false;
    if (action === "deleteColumn" && width === 1) return false;
    if (dispatch === undefined) return true;
    const rows = rectangularRows(table);
    let targetRow = row;
    let targetColumn = column;
    if (action === "addRow") {
      const header = rows[0];
      if (header === undefined) throw new Error("表格缺少表头");
      rows.splice(row + 1, 0, emptyRow(header));
      targetRow += 1;
    } else if (action === "deleteRow") {
      rows.splice(row, 1);
      targetRow = Math.min(row, rows.length - 1);
    } else {
      for (let index = 0; index < rows.length; index++) {
        const current = rows[index];
        if (current === undefined) throw new Error("表格行不存在");
        const cells = [...current.content.content];
        if (action === "addColumn")
          cells.splice(
            column + 1,
            0,
            table.type.schema.node(index === 0 ? "table_header" : "table_cell"),
          );
        else if (action === "deleteColumn") cells.splice(column, 1);
        else {
          const cell = cells[column];
          if (cell === undefined) throw new Error("表格列不存在");
          cells[column] = cell.type.create(
            { ...cell.attrs, align: action },
            cell.content,
            cell.marks,
          );
        }
        rows[index] = current.type.create(current.attrs, cells, current.marks);
      }
      if (action === "addColumn") targetColumn += 1;
      else if (action === "deleteColumn") targetColumn = Math.min(column, width - 2);
    }
    const next = table.type.create(table.attrs, rows, table.marks);
    const transaction = closeHistory(state.tr).replaceWith(
      position,
      position + table.nodeSize,
      next,
    );
    // 对齐不改变内容或位置，保留原选区；结构操作才把光标移到新的可写单元格。
    dispatch(
      ["left", "center", "right"].includes(action)
        ? transaction.setSelection(state.selection.getBookmark().resolve(transaction.doc))
        : selectCell(transaction, position, next, targetRow, targetColumn),
    );
    return true;
  };
}

const insert: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to) || !["paragraph", "heading"].includes($from.parent.type.name))
    return false;
  const schema = state.schema;
  const table = schema.node("table", null, [
    schema.node("table_row", null, [schema.node("table_header"), schema.node("table_header")]),
    schema.node("table_row", null, [schema.node("table_cell"), schema.node("table_cell")]),
  ]);
  const parent = $from.node(-1);
  const index = $from.index(-1);
  const replaceEmpty =
    $from.parent.content.size === 0 && parent.canReplaceWith(index, index + 1, table.type);
  if (!replaceEmpty && !parent.canReplaceWith(index + 1, index + 1, table.type)) return false;
  if (dispatch !== undefined) {
    const position = replaceEmpty ? $from.before() : $from.after();
    const end = replaceEmpty ? $from.after() : position;
    dispatch(
      selectCell(closeHistory(state.tr).replaceWith(position, end, table), position, table, 0, 0),
    );
  }
  return true;
};

const remove: Command = (state, dispatch) => {
  const location = context(state);
  if (location === null) return false;
  if (dispatch !== undefined) {
    const { position, table } = location;
    const transaction = closeHistory(state.tr).replaceWith(
      position,
      position + table.nodeSize,
      state.schema.node("paragraph"),
    );
    dispatch(
      transaction
        .setSelection(TextSelection.create(transaction.doc, position + 1))
        .scrollIntoView(),
    );
  }
  return true;
};

/**
 * 表格命令保持矩形和首行表头，操作与选区一起进入一次撤销事务。
 * 能力查询不派发事务；最后一列、表头行不能单独删除，整表使用 remove。
 */
export const tableCommands = {
  insert,
  remove,
  addRow: change("addRow"),
  deleteRow: change("deleteRow"),
  addColumn: change("addColumn"),
  deleteColumn: change("deleteColumn"),
  alignLeft: change("left"),
  alignCenter: change("center"),
  alignRight: change("right"),
} satisfies Record<string, Command>;

/**
 * 表格中按单元格导航；Tab 在末尾添行，Enter 沿同列向下，Shift+Tab 返回上一格。
 * @param direction 导航方向；无表格选区时返回 false，让其他编辑器命令处理。
 */
export function moveTableCell(direction: "next" | "previous" | "down"): Command {
  return (state, dispatch) => {
    const location = context(state);
    if (location === null) return false;
    const { table, position, column, row } = location;
    let nextRow = row;
    let nextColumn = column;
    if (direction === "down") nextRow += 1;
    else if (direction === "previous") {
      if (column > 0) nextColumn -= 1;
      else if (row > 0) {
        nextRow -= 1;
        nextColumn = table.child(nextRow).childCount - 1;
      } else return false;
    } else if (column + 1 < table.child(row).childCount) nextColumn += 1;
    else {
      nextRow += 1;
      nextColumn = 0;
    }
    if (nextRow === table.childCount) {
      if (dispatch === undefined) return true;
      return tableCommands.addRow(state, (transaction) => {
        const next = transaction.doc.nodeAt(position);
        if (next === null) throw new Error("新增表格行失败");
        dispatch(selectCell(transaction, position, next, nextRow, nextColumn));
      });
    }
    nextColumn = Math.min(nextColumn, table.child(nextRow).childCount - 1);
    if (dispatch !== undefined)
      dispatch(selectCell(state.tr, position, table, nextRow, nextColumn));
    return true;
  };
}

/** 从表格返回后续正文；文末没有段落时创建段落，仍可撤销，不把换行塞入单元格。 */
export const leaveTable: Command = (state, dispatch) => {
  const location = context(state);
  if (location === null) return false;
  if (dispatch !== undefined) {
    const after = location.position + location.table.nodeSize;
    const next = state.doc.nodeAt(after);
    const transaction =
      next?.type.name === "paragraph"
        ? state.tr
        : closeHistory(state.tr).insert(after, state.schema.node("paragraph"));
    dispatch(
      transaction.setSelection(TextSelection.create(transaction.doc, after + 1)).scrollIntoView(),
    );
  }
  return true;
};
