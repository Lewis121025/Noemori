import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { getMatchHighlights } from "prosemirror-search";
import { frontmatterBlock } from "../frontmatter";

/** 一处实际高亮的文内命中；位置属于当前文档，跨格式的文字仍计为一处。 */
export type SearchMatch = { readonly from: number; readonly to: number };

/**
 * 从搜索插件已计算的高亮取得顺序一致的命中，不再次扫描全文。
 * @param state 持有搜索插件与当前选区的编辑状态。
 * @returns 按正文位置排列的不重叠命中；空查询或未安装搜索插件时为空。
 */
export function searchMatches(state: EditorState): readonly SearchMatch[] {
  const start = frontmatterBlock(state.doc)?.size ?? 0;
  // 装饰按文档树存储，公开的 find 接口不承诺返回顺序。
  return getMatchHighlights(state)
    .find()
    .filter((match) => match.from >= start)
    .sort((a, b) => a.from - b.from);
}

function findMatch(direction: "next" | "previous"): Command {
  return (state, dispatch) => {
    const matches = searchMatches(state);
    const { from, to } = state.selection;
    const match =
      direction === "next"
        ? (matches.find((item) => item.from >= to) ?? matches[0])
        : (matches.findLast((item) => item.to <= from) ?? matches.at(-1));
    if (match === undefined) return false;
    dispatch?.(
      state.tr.setSelection(TextSelection.create(state.doc, match.from, match.to)).scrollIntoView(),
    );
    return true;
  };
}

/** 选中当前选区之后的高亮命中，文末回到第一处；只改变选区，不修改正文。 */
export const findNextMatch: Command = findMatch("next");

/** 选中当前选区之前的高亮命中，文首回到最后一处；与正向查找使用同一组命中。 */
export const findPreviousMatch: Command = findMatch("previous");
