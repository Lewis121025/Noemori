import { Plugin, PluginKey, type EditorState, type Command } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

/** 文档写入权限、工具模式与原生控件装饰；只读不阻止选区、查找和折叠等浏览操作。 */
type AccessState = { readOnly: boolean; reading: boolean; controls: DecorationSet };
const accessKey = new PluginKey<AccessState>("document-access");
const readingKey = new PluginKey<boolean>("document-reading-mode");
const accessControls = new Set([
  "list_item",
  "callout",
  "code_block",
  "math_inline",
  "math_block",
  "html_inline",
  "html_block",
  "comment_inline",
  "comment_block",
]);

function accessState(state: EditorState, readOnly: boolean, reading: boolean): AccessState {
  const controls: Decoration[] = [];
  if (readOnly || reading)
    state.doc.descendants((node, pos) => {
      if (accessControls.has(node.type.name))
        controls.push(Decoration.node(pos, pos + node.nodeSize, {}, { readOnly: true }));
    });
  return { readOnly, reading, controls: DecorationSet.create(state.doc, controls) };
}

/** @returns 当前文档是否允许完整编辑工具；未装载权限插件的独立命令测试默认允许。 */
export function canUseEditingTools(state: EditorState): boolean {
  const access = accessKey.getState(state);
  return !access?.readOnly && !access?.reading;
}

/** 为格式和结构命令统一加上模式门禁；执行时消费按键，防止浏览器默认格式命令绕过限制。 */
export function editingCommand(command: Command): Command {
  return (state, dispatch, view) =>
    canUseEditingTools(state) ? command(state, dispatch, view) : dispatch !== undefined;
}

/**
 * 在事务提交边界拒绝只读文档的所有内容变更，包括快捷键、历史、替换和追加事务。
 * @param readOnly 会话初始权限；后续通过 setDocumentReadOnly 原位切换。
 * @param reading 阅读模式允许正文与标注，完整编辑工具仍受模式门禁约束。
 * @returns 同时驱动输入能力、控件更新与阅读样式的插件，不重建文档或清空历史。
 */
export function documentAccess(readOnly: boolean, reading = false): Plugin<AccessState> {
  return new Plugin<AccessState>({
    key: accessKey,
    state: {
      init: (_config, state) => accessState(state, readOnly, reading),
      apply(tr, previous, _oldState, state) {
        const next: unknown = tr.getMeta(accessKey);
        const locked = typeof next === "boolean" ? next : previous.readOnly;
        const readingMode: unknown = tr.getMeta(readingKey);
        const reading = typeof readingMode === "boolean" ? readingMode : previous.reading;
        return locked !== previous.readOnly || reading !== previous.reading || tr.docChanged
          ? accessState(state, locked, reading)
          : previous;
      },
    },
    filterTransaction: (tr, state) => !tr.docChanged || !accessKey.getState(state)?.readOnly,
    props: {
      editable: (state) => !accessKey.getState(state)?.readOnly,
      attributes: (state) => ({
        tabindex: "0",
        class:
          accessKey.getState(state)?.readOnly || accessKey.getState(state)?.reading
            ? "markdown-content reading"
            : "markdown-content",
      }),
      decorations: (state) => accessKey.getState(state)?.controls ?? null,
    },
  });
}

/** 原位切换只读权限和阅读模式；阅读保留正文输入，退出节点源码编辑且保留历史与选区。 */
export function setDocumentReadOnly(view: EditorView, readOnly: boolean, reading = false): void {
  const previous = accessKey.getState(view.state);
  if (previous?.readOnly === readOnly && previous.reading === reading) return;
  const tr = view.state.tr.setMeta(accessKey, readOnly).setMeta(readingKey, reading);
  view.dispatch(tr);
}

/**
 * 将焦点与选区交回正文；只读表面没有 contenteditable，须显式同步原生选区。
 * ProseMirror 的 focus 在只读时不会获取焦点，且没有 DOM 选区时不会画出已有选区。
 */
export function focusDocument(view: EditorView): void {
  if (!view.editable) {
    view.dom.focus({ preventScroll: true });
    const { anchor, head } = view.state.selection;
    const from = view.domAtPos(anchor);
    const to = view.domAtPos(head);
    view.dom.ownerDocument
      .getSelection()
      ?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  }
  view.focus();
}
