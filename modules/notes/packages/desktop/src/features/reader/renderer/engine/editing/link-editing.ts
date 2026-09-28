import {
  Plugin,
  PluginKey,
  type Command,
  type EditorState,
  type SelectionBookmark,
} from "prosemirror-state";
import type { LinkKind } from "../../../shared/api";
import { externalUrl, hasUrlScheme } from "../../../shared/link-target";
import { documentSchema } from "../markdown/schema";

/** 链接弹窗打开前的选区书签；true 捕获、false 释放，其余事务只映射位置。 */
export const linkSelectionKey = new PluginKey<SelectionBookmark | null>("linkSelection");

/**
 * 书签属于编辑会话，随事务映射而不进入撤销历史；关闭弹窗后释放。
 * 在编辑器创建时注册，避免动态重配插件销毁正在工作的附件与预览会话。
 */
export const linkSelectionPlugin = createLinkSelectionPlugin();

/** 外部重载时接收已映射的弹窗书签；普通首次挂载以 null 开始。 */
export function createLinkSelectionPlugin(initial: SelectionBookmark | null = null) {
  return new Plugin<SelectionBookmark | null>({
    key: linkSelectionKey,
    state: {
      init: () => initial,
      apply(tr, bookmark, previous) {
        const action: unknown = tr.getMeta(linkSelectionKey);
        if (action === false) return null;
        const selected = action === true ? previous.selection.getBookmark() : bookmark;
        return selected?.map(tr.mapping) ?? null;
      },
    },
  });
}

/**
 * 创建链接命令；同一文本块内保持原选区格式，跨块或代码位置不修改文档。
 * @param target 内部目标或外部 URL；wiki 目标不能包含分隔符。
 * @param label 显示文字，空值使用目标。
 * @param kind 内部 wiki 链接或标准 Markdown 链接。
 * @returns 遵循 ProseMirror 可执行性查询与事务提交约定的命令。
 * @throws 目标为空、语法非法或外部协议不允许时失败。
 */
export function insertLink(target: string, label: string, kind: LinkKind): Command {
  const raw = target.trim();
  if (raw === "" || /[\r\n]/.test(raw)) throw new Error("请输入有效的链接目标");
  if (kind === "wiki" && /[[\]|]/.test(raw)) throw new Error("笔记路径不能包含双括号或竖线");
  if (kind === "wiki" && hasUrlScheme(raw))
    throw new Error("库内笔记请输入相对路径；网页请切换链接类型");
  const href = hasUrlScheme(raw) ? externalUrl(raw) : raw;
  return (state, dispatch) => {
    const { from, to, $from, $to } = state.selection;
    if (!$from.sameParent($to) || !$from.parent.inlineContent || $from.parent.type.spec.code)
      return false;
    const title = label || raw;
    const tr = state.tr;
    if (kind === "wiki") {
      tr.replaceSelectionWith(
        documentSchema.node("wiki_link", { target: raw, alias: title === raw ? null : title }),
      );
    } else {
      const previous = selectedLink(state);
      const original =
        previous?.kind === "md"
          ? state.doc.nodeAt(previous.from)?.marks.find((mark) => mark.type.name === "link")
          : undefined;
      const sameTarget = previous?.kind === "md" && previous.target === raw;
      // 对话框不编辑标题；改文字时沿用引用，改地址时仅解除当前链接的引用关系。
      const mark = documentSchema.mark("link", {
        ...original?.attrs,
        href: sameTarget ? previous.target : href,
        reference: sameTarget ? (original?.attrs["reference"] ?? null) : null,
      });
      if (from !== to && state.doc.textBetween(from, to) === title) {
        tr.addMark(from, to, mark);
      } else {
        const marks = (state.storedMarks ?? $from.marks()).filter(
          (item) => item.type.name !== "link",
        );
        tr.replaceSelectionWith(documentSchema.text(title, [...marks, mark]), false);
      }
      tr.removeStoredMark(documentSchema.marks["link"]!);
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/** 链接编辑的完整范围；文本链接以相同 mark 为边界，wiki 链接占一个原子节点。 */
export type LinkSelection = {
  from: number;
  to: number;
  kind: LinkKind;
  target: string;
  label: string;
};

/**
 * 读取选区或光标处的链接，不改变文档；相邻不同目标的链接不会被合并。
 * @param state 当前文档状态。
 * @returns 已有链接及完整范围；普通文字或跨链接选区返回 null。
 */
export function selectedLink(state: EditorState): LinkSelection | null {
  const { from, to, $from } = state.selection;
  const atom = state.doc.nodeAt(from);
  if (atom?.type.name === "wiki_link" && to <= from + atom.nodeSize) {
    const target = String(atom.attrs["target"]);
    return {
      from,
      to: from + atom.nodeSize,
      kind: "wiki",
      target,
      label: String(atom.attrs["alias"] ?? target),
    };
  }
  const marks = $from.nodeAfter?.marks ?? $from.marks();
  const link = marks.find((mark) => mark.type.name === "link");
  if (!link) return null;
  let start = $from.start();
  let end = start;
  let found = false;
  for (const child of $from.parent.content.content) {
    const linked = !!link.isInSet(child.marks);
    if (!linked) {
      if (found) break;
      start = end + child.nodeSize;
    } else if (end <= from && from <= end + child.nodeSize) found = true;
    end += child.nodeSize;
  }
  if (!found || to > end) return null;
  return {
    from: start,
    to: end,
    kind: "md",
    target: String(link.attrs["href"]),
    label: state.doc.textBetween(start, end),
  };
}

/** 移除已有链接但保留可见文字及其余格式；普通选区返回 false。 */
export const removeLink: Command = (state, dispatch) => {
  const link = selectedLink(state);
  if (!link) return false;
  const tr = state.tr;
  if (link.kind === "md") tr.removeMark(link.from, link.to, documentSchema.marks["link"]!);
  else {
    const marks = state.doc.nodeAt(link.from)?.marks ?? [];
    tr.replaceWith(link.from, link.to, documentSchema.text(link.label, marks));
  }
  dispatch?.(tr.scrollIntoView());
  return true;
};
