import type { Node as PmNode } from "prosemirror-model";
import { Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import { isHistoryTransaction } from "prosemirror-history";
import { Decoration, DecorationSet, type NodeViewConstructor } from "prosemirror-view";
import { frontmatterBlock } from "./frontmatter-edit";

/** 属性面板的显式写入许可；正文输入不得修改隐藏的 YAML，撤销仍由统一历史处理。 */
export const frontmatterEditKey = new PluginKey("frontmatter-edit");

/**
 * 属性由不透明节点视图承载，浏览器重新解析相邻正文时直接复用原内容，保留 CRLF。
 * 普通源码保留块继续提供 contentDOM，保持原有就地编辑行为。
 * @param node 当前源码保留块；更新只接受同类节点。
 * @param decorations 属性呈现插件标记的只读展示边界。
 * @returns 属性块无可编辑 DOM，普通源码块保留文本编辑入口。
 */
export const frontmatterSourceView: NodeViewConstructor = (node, _view, _getPos, decorations) => {
  const opaque = decorations.some((decoration) => decoration.spec.frontmatter === true);
  const dom = document.createElement("pre");
  dom.dataset.markdownSource = "block";
  const code = document.createElement("code");
  dom.append(code);
  if (opaque) code.textContent = node.textContent;
  return {
    dom,
    ...(opaque ? {} : { contentDOM: code }),
    update(next, nextDecorations) {
      if (
        next.type !== node.type ||
        nextDecorations.some((decoration) => decoration.spec.frontmatter === true) !== opaque
      )
        return false;
      if (opaque) code.textContent = next.textContent;
      return true;
    },
    ignoreMutation: () => opaque,
  };
};

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
              Decoration.node(
                0,
                block.size,
                {
                  hidden: "",
                  "aria-hidden": "true",
                  contenteditable: "false",
                  "data-frontmatter": "",
                },
                { frontmatter: true },
              ),
            ]);
      },
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(frontmatterEditKey) === true || isHistoryTransaction(tr))
        return true;
      const block = frontmatterBlock(state.doc);
      const after = tr.doc.firstChild;
      // 正文退格、剪切和跨边界替换不能顺带删掉或改写属性；面板操作显式声明意图。
      return block === null || (after !== null && state.doc.firstChild?.eq(after) === true);
    },
    appendTransaction(_transactions, _oldState, state) {
      const selection = bodySelection(state.doc, state.selection);
      return selection.eq(state.selection) ? null : state.tr.setSelection(selection);
    },
  });
}
