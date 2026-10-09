import type { Node as PmNode } from "prosemirror-model";
import { headingText } from "../../shared/markdown/outline";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

/** 标题及其后续同级块组成章节；嵌套容器中的标题只管理本容器内的内容。 */
export type HeadingSection = {
  pos: number;
  from: number;
  to: number;
  level: number;
  title: string;
};
/** 隐藏的完整块范围，不包含负责展开它的标题。 */
export type FoldedHeadingRange = { from: number; to: number };
type FoldState = {
  sections: readonly HeadingSection[];
  collapsed: ReadonlySet<number>;
  hidden: readonly FoldedHeadingRange[];
  decorations: DecorationSet;
};
const foldKey = new PluginKey<FoldState>("heading-fold");
const noRanges: readonly FoldedHeadingRange[] = [];

/**
 * 按标题层级计算章节边界，不依赖 DOM 或修改文档。
 * @param doc 当前不可变编辑器文档。
 * @returns 按源码位置排列的章节；空章节保留范围，调用方据此隐藏无效入口。
 */
export function headingSections(doc: PmNode): HeadingSection[] {
  const result: HeadingSection[] = [];
  function visit(parent: PmNode, start: number): void {
    const pending: HeadingSection[] = [];
    parent.forEach((node, offset) => {
      const pos = start + offset;
      if (node.type.name === "heading") {
        const level = Number(node.attrs["level"]);
        while (pending.length && pending[pending.length - 1]!.level >= level)
          pending.pop()!.to = pos;
        const section = {
          pos,
          from: pos + node.nodeSize,
          to: start + parent.content.size,
          level,
          title: headingText(node),
        };
        pending.push(section);
        result.push(section);
      }
      if (!node.isLeaf && !node.isTextblock) visit(node, pos + 1);
    });
  }
  visit(doc, 0);
  return result;
}

/** 返回当前视图的隐藏范围；未安装折叠插件时返回稳定空数组，不访问 DOM。 */
export function foldedHeadingRanges(state: EditorState): readonly FoldedHeadingRange[] {
  return foldKey.getState(state)?.hidden ?? noRanges;
}

function intersects(section: FoldedHeadingRange, state: EditorState): boolean {
  const { from, to, empty } = state.selection;
  return empty ? from >= section.from && from < section.to : from < section.to && to > section.from;
}

/**
 * 切换指定标题的阅读折叠；隐藏当前选区前将光标移回该标题末尾。
 * @param pos 标题节点在当前文档中的位置。
 * @returns 标准命令；无插件、非标题或空章节返回 false，不派发文档写入或撤销事件。
 */
export function toggleHeadingFold(pos: number): Command {
  return (state, dispatch) => {
    const folding = foldKey.getState(state);
    const section = folding?.sections.find((item) => item.pos === pos);
    if (!folding || !section || section.from === section.to) return false;
    if (dispatch) {
      const tr = state.tr.setMeta(foldKey, pos).setMeta("addToHistory", false);
      if (!folding.collapsed.has(pos) && intersects(section, state))
        tr.setSelection(TextSelection.create(state.doc, section.from - 1));
      dispatch(tr);
    }
    return true;
  };
}

function foldButton(
  view: EditorView,
  getPos: () => number | undefined,
  section: HeadingSection,
  collapsed: boolean,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "heading-fold-toggle";
  button.contentEditable = "false";
  button.title = collapsed ? "展开章节" : "折叠章节";
  button.setAttribute("aria-label", `${button.title}：${section.title || "未命名标题"}`);
  button.setAttribute("aria-expanded", String(!collapsed));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", "m5 3 4 4-4 4");
  svg.append(path);
  button.append(svg);
  button.onmousedown = (event) => event.preventDefault();
  button.onclick = () => {
    const at = getPos();
    if (at === undefined || view.isDestroyed || view.composing) return;
    const focused = document.activeElement === button;
    toggleHeadingFold(at - 1)(view.state, view.dispatch, view);
    // 装饰更新会替换按钮；键盘用户继续留在同一个章节控制上。
    const heading = view.nodeDOM(at - 1);
    if (focused && heading instanceof HTMLElement)
      heading
        .querySelector<HTMLButtonElement>(".heading-fold-toggle")
        ?.focus({ preventScroll: true });
  };
  button.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      view.focus();
    }
  };
  return button;
}

function present(
  doc: PmNode,
  sections: readonly HeadingSection[],
  collapsed: ReadonlySet<number>,
): FoldState {
  const hidden: FoldedHeadingRange[] = [];
  for (const section of sections) {
    if (!collapsed.has(section.pos)) continue;
    const previous = hidden[hidden.length - 1];
    if (previous && section.from <= previous.to) previous.to = Math.max(previous.to, section.to);
    else hidden.push({ from: section.from, to: section.to });
  }
  const decorations: Decoration[] = [];
  for (const section of sections) {
    if (section.from === section.to) continue;
    const folded = collapsed.has(section.pos);
    decorations.push(
      Decoration.node(section.pos, section.from, {
        class: "heading-foldable",
        "data-heading-folded": String(folded),
        "aria-label": section.title || "未命名标题",
      }),
      Decoration.widget(
        section.pos + 1,
        (view, getPos) => foldButton(view, getPos, section, folded),
        {
          side: -1,
          key: `${section.pos}:${folded}:${section.title}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    );
  }
  for (const range of hidden) {
    doc.nodesBetween(range.from, range.to, (node, pos) => {
      // nodesBetween 也会访问包裹范围的祖先，不能把包含标题的整个引用或列表一并隐藏。
      if (pos < range.from || pos + node.nodeSize > range.to) return true;
      if (node.isBlock)
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            hidden: "",
            "aria-hidden": "true",
            class: "heading-fold-hidden",
          }),
        );
      return false;
    });
  }
  return { sections, collapsed, hidden, decorations: DecorationSet.create(doc, decorations) };
}

/**
 * 创建仅属于当前文档视图的标题折叠插件；位置随编辑映射，显式定位会展开覆盖目标的章节。
 * @returns 不改变 Markdown 节点或历史的插件；折叠内容仍参与保存、复制和导出。
 */
export function headingFolding(): Plugin<FoldState> {
  return new Plugin<FoldState>({
    key: foldKey,
    state: {
      init: (_config, state) => present(state.doc, headingSections(state.doc), new Set()),
      apply(tr, previous, _old, state) {
        const sections = tr.docChanged ? headingSections(state.doc) : previous.sections;
        const available = new Map(
          sections.filter((item) => item.from < item.to).map((item) => [item.pos, item]),
        );
        let collapsed = new Set<number>();
        for (const pos of previous.collapsed) {
          const mapped = tr.mapping.mapResult(pos, 1);
          if (!mapped.deleted && available.has(mapped.pos)) collapsed.add(mapped.pos);
        }
        const toggle: unknown = tr.getMeta(foldKey);
        if (typeof toggle === "number" && available.has(toggle)) {
          if (collapsed.has(toggle)) collapsed.delete(toggle);
          else collapsed.add(toggle);
        } else if (tr.selectionSet || tr.docChanged || tr.scrolledIntoView) {
          collapsed = new Set(
            [...collapsed].filter((pos) => !intersects(available.get(pos)!, state)),
          );
        }
        if (
          !tr.docChanged &&
          collapsed.size === previous.collapsed.size &&
          [...collapsed].every((pos) => previous.collapsed.has(pos))
        )
          return previous;
        return present(state.doc, sections, collapsed);
      },
    },
    props: {
      decorations: (state) => foldKey.getState(state)?.decorations ?? DecorationSet.empty,
      handleKeyDown(view, event) {
        if (
          event.isComposing ||
          view.composing ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          !view.state.selection.empty
        )
          return false;
        const folding = foldKey.getState(view.state);
        const { $from } = view.state.selection;
        if (!folding || !$from.parent.isTextblock || $from.depth === 0) return false;
        const pos = $from.before();
        const current = folding.sections.find(
          (section) => section.pos === pos && folding.collapsed.has(pos),
        );
        if (current && event.key === "Enter") {
          toggleHeadingFold(current.pos)(view.state, view.dispatch, view);
          return false;
        }
        // 删除隐藏边界前先展开，避免一次退格就合并用户看不到的正文。
        const opening =
          event.key === "Delete" && $from.parentOffset === $from.parent.content.size
            ? current
            : event.key === "Backspace" && $from.parentOffset === 0
              ? folding.sections.find(
                  (section) => section.to === pos && folding.collapsed.has(section.pos),
                )
              : undefined;
        if (!opening) return false;
        toggleHeadingFold(opening.pos)(view.state, view.dispatch, view);
        return true;
      },
    },
  });
}
