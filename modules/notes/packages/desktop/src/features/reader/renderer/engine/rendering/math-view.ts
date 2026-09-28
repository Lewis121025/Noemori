/**
 * 公式 NodeView 与最小输入：打开时排版，滚动不再卸预览。
 * 显式进入源码才改 TeX，退出后重排当前公式。
 */
import { inputRules, InputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PmNode } from "prosemirror-model";
import {
  NodeSelection,
  type Command,
  type EditorState,
  type Plugin,
  type Transaction,
} from "prosemirror-state";
import type { Decoration, EditorView, NodeViewConstructor } from "prosemirror-view";
import { peekRenderedTex, renderTex } from "./mathjax";
import { documentSchema } from "../markdown/schema";
import { SourceNodeView } from "./source-node-view";
import { sourceEditingKey } from "../editing/source-editing";
import { mathPlaceholderText } from "./viewport";

function createMathNodeView(
  node: PmNode,
  view: EditorView,
  getPos: () => number | undefined,
  decorations: readonly Decoration[],
): SourceNodeView {
  return new SourceNodeView(
    node,
    view,
    getPos,
    {
      kind: "math",
      render(dom, tex, display, signal) {
        const cached = peekRenderedTex(tex, display);
        if (cached !== null) {
          dom.replaceChildren(cached);
          return;
        }
        dom.textContent = mathPlaceholderText(tex, display);
        void renderTex(tex, display).then((rendered) => {
          if (!signal.aborted) dom.replaceChildren(rendered);
        });
      },
    },
    decorations,
  );
}

/** 行内与块级公式共用源码编辑生命周期，预览只负责 MathJax 排版。 */
export const mathNodeViews: Record<string, NodeViewConstructor> = {
  math_inline: createMathNodeView,
  math_block: createMathNodeView,
};

function insertInlineMath(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
): Transaction | null {
  const tex = match[1];
  if (tex === undefined || tex === "") {
    return null;
  }
  const node = documentSchema.node("math_inline", { tex });
  return state.tr.replaceWith(start, end, node);
}

const insertMathBlock: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== "paragraph") {
    return false;
  }
  if ($from.parent.textContent !== "$$") {
    return false;
  }
  if (dispatch) {
    const node = documentSchema.node("math_block", { tex: "" });
    const pos = $from.before();
    const tr = state.tr.replaceWith(pos, $from.after(), node);
    dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)).setMeta(sourceEditingKey, true));
  }
  return true;
};

/**
 * 最小输入：行内收尾 `$`；空段落 `$$` 再 Enter 出块级。
 *
 * @returns 应插在 baseKeymap 之前的插件。
 */
export function mathInputPlugins(): Plugin[] {
  return [
    inputRules({
      rules: [new InputRule(/\$([^$\n]+)\$$/, insertInlineMath)],
    }),
    keymap({ Enter: insertMathBlock }),
  ];
}
