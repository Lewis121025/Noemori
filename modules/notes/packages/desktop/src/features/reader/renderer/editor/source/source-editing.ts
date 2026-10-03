import { canUseEditingTools } from "../read-only";
import { NodeSelection, Plugin, PluginKey, type Command } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { isCompositionKey } from "../composition";

/** 源码编辑属于当前节点选区的临时状态，不写入文档或撤销历史。 */
export const sourceEditingKey = new PluginKey<boolean>("sourceEditing");

const sourceNodes = new Set(["math_inline", "math_block", "html_inline", "html_block"]);

/** 仅显式操作进入源码；普通节点选择继续保留预览和正文焦点。 */
export const editSelectedSource: Command = (state, dispatch, view) => {
  if (!canUseEditingTools(state) || (view !== undefined && !view.editable)) return false;
  const selection = state.selection;
  if (!(selection instanceof NodeSelection) || !sourceNodes.has(selection.node.type.name))
    return false;
  dispatch?.(state.tr.setMeta(sourceEditingKey, true));
  return true;
};

/**
 * 统一管理源码节点的选择与编辑状态；移动选区自动退出编辑，内容更新保留输入框。
 * 通过节点装饰通知 NodeView，不建立独立文档或第二套撤销栈。
 */
export const sourceEditingPlugin = createSourceEditingPlugin();

/** 重载同一源码节点时可恢复显式编辑状态，不把普通节点选择当成进入编辑。 */
export function createSourceEditingPlugin(initial = false) {
  return new Plugin<boolean>({
    key: sourceEditingKey,
    state: {
      init: () => initial,
      apply(tr, editing, previous, state) {
        // 权限插件先更新；源码会话自己结束临时编辑，避免权限层反向依赖具体编辑工具。
        if (!canUseEditingTools(state)) return false;
        const explicit: unknown = tr.getMeta(sourceEditingKey);
        if (typeof explicit === "boolean") return explicit;
        return tr.selection.eq(previous.selection) && editing;
      },
    },
    props: {
      decorations(state) {
        const { selection } = state;
        if (!sourceEditingKey.getState(state) || !(selection instanceof NodeSelection)) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(selection.from, selection.to, {}, { sourceEditing: true }),
        ]);
      },
      handleKeyDown(view, event) {
        if (
          isCompositionKey(event) ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey
        )
          return false;
        return event.key === "Enter" && editSelectedSource(view.state, view.dispatch, view);
      },
      handleDoubleClickOn(view, _pos, node, nodePos, event) {
        if (
          !view.editable ||
          !canUseEditingTools(view.state) ||
          event.ctrlKey ||
          event.metaKey ||
          !sourceNodes.has(node.type.name)
        )
          return false;
        view.dispatch(
          view.state.tr
            .setSelection(NodeSelection.create(view.state.doc, nodePos))
            .setMeta(sourceEditingKey, true),
        );
        return true;
      },
    },
  });
}
