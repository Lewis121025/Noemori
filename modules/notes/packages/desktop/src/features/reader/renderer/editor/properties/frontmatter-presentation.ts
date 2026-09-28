import type { Node as PmNode } from "prosemirror-model";
import { Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import { isHistoryTransaction } from "prosemirror-history";
import { Decoration, DecorationSet } from "prosemirror-view";
import { frontmatterBlock } from "./frontmatter-edit";

/** 属性面板的显式写入许可；正文输入不得修改隐藏的 YAML，撤销仍由统一历史处理。 */
export const frontmatterEditKey = new PluginKey("frontmatter-edit");

/**
 * 将排版选区限定到可见正文，保留选区方向；源码模式继续访问完整文件。
 * @param doc 包含原始属性块的完整文档。
 * @param selection 待恢复或应用的选区；缺省时定位正文开头。
 * @returns 正文中的选区；没有属性或正文时保持原选区。
 */
export function bodySelection(doc: PmNode, selection = Selection.atStart(doc)): Selection {
  const block = frontmatterBlock(doc);
  if (block === null || selection.from >= block.size || doc.childCount === 1) return selection;
  return TextSelection.between(
    doc.resolve(Math.max(block.size, selection.anchor)),
    doc.resolve(Math.max(block.size, selection.head)),
  );
}

/**
 * 属性保留在同一文档与保存管线中，排版、嵌入和只读预览只展示正文。
 * @returns 隐藏属性、约束选区并保护写入边界的插件；不删节点、不重写属性源码。
 */
export function frontmatterPresentation(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const block = frontmatterBlock(state.doc);
        return block === null
          ? null
          : DecorationSet.create(state.doc, [
              Decoration.node(0, block.size, {
                hidden: "",
                "aria-hidden": "true",
                contenteditable: "false",
                "data-frontmatter": "",
              }),
            ]);
      },
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(frontmatterEditKey) === true || isHistoryTransaction(tr))
        return true;
      const block = frontmatterBlock(state.doc);
      const after = tr.doc.firstChild;
      if (block !== null && !(after !== null && state.doc.firstChild?.eq(after) === true)) console.info("frontmatter-blocked", JSON.stringify({selection: state.selection.toJSON(), steps: tr.steps.map((step) => { const value = step.toJSON(); return {type: value.stepType, from: value.from, to: value.to}; }), beforeSize: state.doc.firstChild?.nodeSize, afterSize: after?.nodeSize}));
      // 正文退格、剪切和跨边界替换不能顺带删掉或改写属性；面板操作显式声明意图。
      return block === null || (after !== null && state.doc.firstChild?.eq(after) === true);
    },
    appendTransaction(_transactions, _oldState, state) {
      const selection = bodySelection(state.doc, state.selection);
      return selection.eq(state.selection) ? null : state.tr.setSelection(selection);
    },
  });
}
