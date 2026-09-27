import type { NodeViewConstructor } from "prosemirror-view";

/**
 * 列表项保留可编辑内容区，任务按钮只通过事务修改 checked，支持键盘操作与撤销。
 * @param node 当前列表项。
 * @param view 所属编辑器。
 * @param getPos 当前文档位置，移动列表后重新获取以避免写错节点。
 * @returns 由编辑器负责销毁的节点视图。
 */
export const taskItemView: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.contentEditable = "false";
  button.className = "task-checkbox";
  button.setAttribute("role", "checkbox");
  const contentDOM = document.createElement("div");
  contentDOM.className = "list-item-content";
  dom.append(button, contentDOM);
  const update = (next: typeof node): boolean => {
    if (next.type !== node.type) return false;
    const checked = next.attrs["checked"];
    button.disabled = !view.editable;
    button.hidden = typeof checked !== "boolean";
    if (typeof checked === "boolean") {
      dom.dataset["checked"] = String(checked);
      button.setAttribute("aria-checked", String(checked));
      button.setAttribute("aria-label", checked ? "标记任务未完成" : "标记任务完成");
    } else delete dom.dataset["checked"];
    return true;
  };
  button.onmousedown = (event) => event.preventDefault();
  button.onclick = () => {
    if (!view.editable) return;
    const pos = getPos();
    if (pos === undefined) return;
    const current = view.state.doc.nodeAt(pos);
    if (current?.type !== node.type || typeof current.attrs["checked"] !== "boolean") return;
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, {
        ...current.attrs,
        checked: !current.attrs["checked"],
      }),
    );
  };
  update(node);
  return {
    dom,
    contentDOM,
    update,
    stopEvent: (event) => event.target === button,
    ignoreMutation: (mutation) =>
      mutation.type !== "selection" &&
      (mutation.target === button ||
        button.contains(mutation.target) ||
        (mutation.target === dom && mutation.type === "attributes")),
  };
};
