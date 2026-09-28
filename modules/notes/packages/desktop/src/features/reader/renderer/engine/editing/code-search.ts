import { getSearchQuery, SearchQuery, setSearchQuery } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

/**
 * 将源码查找框的输入立即提交到 CodeMirror 查询状态。
 * 内置面板只监听 keyup/change，粘贴后第一次回车与按钮替换会读取旧查询。
 * @param view 拥有内置查找面板的源码编辑器。
 * @returns 卸载时移除监听；查询更新不修改正文，也不移动选区或焦点。
 */
export function bindCodeSearchInput(view: EditorView): () => void {
  const input = (event: Event) => {
    const field = event.target;
    if (
      !(field instanceof HTMLInputElement) ||
      field.closest(".cm-search") === null ||
      (field.name !== "search" && field.name !== "replace")
    )
      return;
    const previous = getSearchQuery(view.state);
    const query = new SearchQuery({
      search: field.name === "search" ? field.value : previous.search,
      replace: field.name === "replace" ? field.value : previous.replace,
      caseSensitive: previous.caseSensitive,
      literal: previous.literal,
      regexp: previous.regexp,
      wholeWord: previous.wholeWord,
      ...(previous.test === undefined ? {} : { test: previous.test }),
    });
    if (!query.eq(previous)) view.dispatch({ effects: setSearchQuery.of(query) });
  };
  view.dom.addEventListener("input", input);
  return () => view.dom.removeEventListener("input", input);
}
