import { chainCommands, exitCode, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { editingCommand } from "./read-only";
import {
  liftListItem,
  sinkListItem,
  splitListItemKeepMarks,
  wrapInList,
} from "prosemirror-schema-list";
import type { Command, EditorState, Plugin, Transaction } from "prosemirror-state";
import { liftTarget } from "prosemirror-transform";
import { documentSchema } from "../../shared/markdown/schema";
import { leaveTable, moveTableCell } from "./table/table";
import { tableClipboard, tableLineBreak } from "./table/table-input";

const nodes = documentSchema.nodes;
const itemType = nodes["list_item"]!;

function listDepth(state: EditorState): number {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--)
    if ($from.node(depth).type === itemType) return depth;
  return 0;
}

function listCommand(name: "bullet_list" | "ordered_list"): Command {
  return (state, dispatch) => {
    const depth = listDepth(state);
    if (depth === 0) return wrapInList(nodes[name]!)(state, dispatch);
    const { $from } = state.selection;
    const list = $from.node(depth - 1);
    if (list.type === nodes[name]) return liftListItem(itemType)(state, dispatch);
    dispatch?.(
      state.tr.setNodeMarkup($from.before(depth - 1), nodes[name], { order: 1 }).scrollIntoView(),
    );
    return true;
  };
}

const taskList: Command = (state, dispatch) => {
  // 面板只查询可用性时复用结构验证，避免为长选区创建随后丢弃的文档与事务。
  if (!dispatch) return listDepth(state) > 0 || wrapInList(nodes["bullet_list"]!)(state);
  let current = state;
  let tr = state.tr;
  if (listDepth(state) === 0) {
    if (
      !wrapInList(nodes["bullet_list"]!)(state, (wrapped) => {
        tr = wrapped;
      })
    )
      return false;
    current = state.apply(tr);
  }
  const depth = listDepth(current);
  if (depth === 0) return false;
  const checked = current.selection.$from.node(depth).attrs["checked"];
  const positions = new Set<number>([current.selection.$from.before(depth)]);
  current.doc.nodesBetween(current.selection.from, current.selection.to, (node, pos) => {
    if (node.type === itemType) positions.add(pos);
  });
  for (const pos of positions) {
    const node = tr.doc.nodeAt(pos);
    if (node?.type === itemType)
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        checked: typeof checked === "boolean" ? null : false,
      });
  }
  dispatch(tr.scrollIntoView());
  return true;
};

const splitItem: Command = (state, dispatch, view) => {
  const depth = listDepth(state);
  const checked = depth > 0 ? state.selection.$from.node(depth).attrs["checked"] : null;
  return splitListItemKeepMarks(itemType, { checked: typeof checked === "boolean" ? false : null })(
    state,
    dispatch,
    view,
  );
};

const quote: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, (node) => node.type === nodes["blockquote"]);
  if (range) {
    // 引用中的列表属于同一个内容块，解除引用不能顺带提升它的列表项。
    const target = liftTarget(range);
    if (target === null) return false;
    dispatch?.(state.tr.lift(range, target).scrollIntoView());
    return true;
  }
  return wrapIn(nodes["blockquote"]!)(state, dispatch);
};

// 代码只能保存文本；把公式、链接节点或附件套入代码会在序列化时丢掉节点语义。
const inlineCode: Command = (state, dispatch, view) => {
  let textOnly = true;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (node.isInline && !node.isText) textOnly = false;
  });
  return (
    textOnly &&
    toggleMark(documentSchema.marks["code"]!, null, { removeWhenPresent: false })(
      state,
      dispatch,
      view,
    )
  );
};

const codeBlock: Command = (state, dispatch, view) => {
  let compatible = true;
  // 块转换作用于整个段落，即使只有光标也要检查选区外的行内节点。
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (!node.isTextblock) return;
    if (
      node.content.content.some(
        (child) =>
          (!child.isText && child.type !== nodes["hard_break"]) ||
          child.marks.some((mark) => mark.type === documentSchema.marks["link"]),
      )
    )
      compatible = false;
    return false;
  });
  return compatible && setBlockType(nodes["code_block"]!)(state, dispatch, view);
};

const codeFence: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const match = /^```([\w+-]*)$/.exec($from.parent.textContent);
  if (!empty || $from.parent.type !== nodes["paragraph"] || match === null) return false;
  // 先验证父节点允许代码块，避免列表首段被删掉围栏后却无法转换。
  if ($from.parentOffset !== $from.parent.content.size || !codeBlock(state)) return false;
  dispatch?.(
    state.tr
      .delete($from.start(), $from.end())
      .setBlockType($from.before(), $from.before() + 1, nodes["code_block"]!, { params: match[1] })
      .scrollIntoView(),
  );
  return true;
};

/** 常用写作命令；只改变当前文档事务，保存与撤销由编辑器统一处理。 */
export const writingCommands = {
  paragraph: editingCommand(setBlockType(nodes["paragraph"]!)),
  heading1: editingCommand(setBlockType(nodes["heading"]!, { level: 1 })),
  heading2: editingCommand(setBlockType(nodes["heading"]!, { level: 2 })),
  heading3: editingCommand(setBlockType(nodes["heading"]!, { level: 3 })),
  heading4: editingCommand(setBlockType(nodes["heading"]!, { level: 4 })),
  heading5: editingCommand(setBlockType(nodes["heading"]!, { level: 5 })),
  heading6: editingCommand(setBlockType(nodes["heading"]!, { level: 6 })),
  // 混合选区一次统一应用；只有全部应用时才取消，工具条与快捷键共用此语义。
  bold: editingCommand(
    toggleMark(documentSchema.marks["strong"]!, null, { removeWhenPresent: false }),
  ),
  italic: editingCommand(
    toggleMark(documentSchema.marks["em"]!, null, { removeWhenPresent: false }),
  ),
  strike: editingCommand(
    toggleMark(documentSchema.marks["strike"]!, null, { removeWhenPresent: false }),
  ),
  highlight: toggleMark(documentSchema.marks["highlight"]!, null, { removeWhenPresent: false }),
  code: editingCommand(inlineCode),
  bulletList: editingCommand(listCommand("bullet_list")),
  orderedList: editingCommand(listCommand("ordered_list")),
  taskList: editingCommand(taskList),
  quote: editingCommand(quote),
  codeBlock: editingCommand(codeBlock),
} satisfies Record<string, Command>;

function taskInput(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
): Transaction | null {
  const depth = listDepth(state);
  if (depth === 0) return null;
  const pos = state.selection.$from.before(depth);
  return state.tr.delete(start, end).setNodeMarkup(pos, undefined, {
    ...state.selection.$from.node(depth).attrs,
    checked: match[1]?.toLowerCase() === "x",
  });
}

/**
 * 注册 Markdown 结构输入和快捷键；代码块不转换，Backspace 可撤销自动转换。
 * @param actions 打开链接与查找界面的回调，不持有宿主或磁盘能力。
 * @returns 位于基础按键映射前的插件，不另建保存或撤销状态。
 */
export function writingPlugins(actions: { link: () => void; search: () => void }): Plugin[] {
  return [
    inputRules({
      rules: [
        textblockTypeInputRule(/^(#{1,6}) $/, nodes["heading"]!, (match) => ({
          level: match[1]!.length,
        })),
        wrappingInputRule(/^\s*> $/, nodes["blockquote"]!),
        wrappingInputRule(/^\s*[-+*] $/, nodes["bullet_list"]!),
        wrappingInputRule(
          /^(\d+)\. $/,
          nodes["ordered_list"]!,
          (match) => ({ order: Number(match[1]) }),
          (match, node) => node.childCount + Number(node.attrs["order"]) === Number(match[1]),
        ),
        new InputRule(/^\[([ xX])\] $/, taskInput),
      ],
    }),
    keymap({
      "Mod-b": writingCommands["bold"]!,
      "Mod-i": writingCommands["italic"]!,
      "Mod-Shift-x": writingCommands["strike"]!,
      "Mod-Shift-h": writingCommands.highlight,
      "Mod-`": writingCommands["code"]!,
      "Mod-Alt-0": writingCommands["paragraph"]!,
      "Mod-Alt-1": writingCommands["heading1"]!,
      "Mod-Alt-2": writingCommands["heading2"]!,
      "Mod-Alt-3": writingCommands["heading3"]!,
      "Mod-Alt-4": writingCommands.heading4,
      "Mod-Alt-5": writingCommands.heading5,
      "Mod-Alt-6": writingCommands.heading6,
      "Mod-k": () => {
        actions.link();
        return true;
      },
      "Mod-f": () => {
        actions.search();
        return true;
      },
      "Mod-Enter": chainCommands(leaveTable, exitCode),
      "Shift-Enter": tableLineBreak,
      Enter: chainCommands(moveTableCell("down"), editingCommand(codeFence), splitItem),
      Tab: chainCommands(moveTableCell("next"), editingCommand(sinkListItem(itemType))),
      "Shift-Tab": chainCommands(moveTableCell("previous"), editingCommand(liftListItem(itemType))),
      Backspace: undoInputRule,
    }),
    tableClipboard,
  ];
}
