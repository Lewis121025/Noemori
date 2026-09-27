import type { Command, EditorState } from "prosemirror-state";
import { getSearchState } from "prosemirror-search";
import { closeHistory } from "prosemirror-history";
import { findNextMatch, searchMatches, type SearchMatch } from "./search-navigation";

function textMatch(state: EditorState, match: SearchMatch): boolean {
  let textOnly = true;
  state.doc.nodesBetween(match.from, match.to, (node) => {
    if (node.isLeaf && !node.isText) textOnly = false;
  });
  return textOnly;
}

/**
 * 按插件的真实文档位置替换普通文字，继承命中首字的格式和链接，不改原子节点属性。
 * @param all 为 true 时一次事务替换所有命中；否则仅替换当前选中的命中并移到下一处。
 * @returns 可查询的编辑命令；替换文本按字面量处理，全部替换可一次撤销。
 */
export function replaceSearch(all: boolean): Command {
  return (state, dispatch, view) => {
    const query = getSearchState(state)?.query;
    if (!query?.valid) return false;
    const matches = searchMatches(state).filter(
      (match) =>
        (all || (match.from === state.selection.from && match.to === state.selection.to)) &&
        textMatch(state, match),
    );
    if (matches.length === 0) return all ? false : findNextMatch(state, dispatch, view);
    if (dispatch) {
      const tr = closeHistory(state.tr);
      for (const match of matches.reverse()) {
        const marks = state.doc.resolve(match.from).nodeAfter?.marks ?? [];
        if (query.replace === "") tr.delete(match.from, match.to);
        else tr.replaceWith(match.from, match.to, state.schema.text(query.replace, marks));
      }
      dispatch(tr.scrollIntoView());
      if (!all && view) findNextMatch(view.state, view.dispatch, view);
    }
    return true;
  };
}
