/**
 * 链接悬停预览的纯逻辑：延迟开合状态机与悬停目标识别。
 *
 * 界面只负责定位弹层和渲染内容；何时打开、何时关闭、预览什么都在这里决定。
 */

import { hasUrlScheme } from "../../shared/link-target";

/** 指针停留多久才打开预览；太短会在扫过正文时频繁弹出。 */
export const HOVER_OPEN_MS = 400;
/** 离开链接后多久关闭；留出把指针移进弹层的时间。 */
export const HOVER_CLOSE_MS = 200;

/** 悬停控制器；`T` 是调用方定义的目标标识。 */
export type HoverController<T> = {
  /** 指针进入链接。 */
  enterLink(item: T): void;
  /** 指针离开链接。 */
  leaveLink(): void;
  /** 指针进入弹层：取消待定关闭。 */
  enterPopover(): void;
  /** 指针离开弹层。 */
  leavePopover(): void;
  /** 立即关闭并取消所有待定动作（滚动、按键、点击、卸载）。 */
  dismiss(): void;
};

/**
 * 创建悬停控制器。
 *
 * @param show 打开或切换到 `item` 的预览。
 * @param hide 关闭预览。
 * @param same 判定两个目标是否相同；默认严格相等。
 */
export function createHoverController<T>({
  show,
  hide,
  same = (left, right) => left === right,
}: {
  show: (item: T) => void;
  hide: () => void;
  same?: (left: T, right: T) => boolean;
}): HoverController<T> {
  let current: { item: T } | null = null;
  let opening: ReturnType<typeof setTimeout> | null = null;
  let closing: ReturnType<typeof setTimeout> | null = null;

  const cancelOpen = () => {
    if (opening !== null) clearTimeout(opening);
    opening = null;
  };
  const cancelClose = () => {
    if (closing !== null) clearTimeout(closing);
    closing = null;
  };
  const scheduleClose = () => {
    cancelClose();
    if (current === null) return;
    closing = setTimeout(() => {
      closing = null;
      current = null;
      hide();
    }, HOVER_CLOSE_MS);
  };

  return {
    enterLink(item) {
      cancelClose();
      cancelOpen();
      if (current !== null && same(current.item, item)) return;
      opening = setTimeout(() => {
        opening = null;
        current = { item };
        show(item);
      }, HOVER_OPEN_MS);
    },
    leaveLink() {
      cancelOpen();
      scheduleClose();
    },
    enterPopover() {
      cancelClose();
    },
    leavePopover() {
      scheduleClose();
    },
    dismiss() {
      cancelOpen();
      cancelClose();
      if (current === null) return;
      current = null;
      hide();
    },
  };
}

/** 可预览的链接目标原文。 */
export type PreviewTarget = { kind: "wiki" | "md"; raw: string };

/**
 * 找出指针所在的可预览链接。
 *
 * 识别 wiki 链接、库内 Markdown 链接与面板里已解析的路径（`data-preview-path`）；
 * 外部地址与弹层内部的链接不预览，避免弹层层层叠起。
 *
 * @returns 链接元素与目标；不可预览时为 null。
 */
export function previewTargetOf(
  element: Element,
): { element: Element; target: PreviewTarget } | null {
  if (element.closest(".hover-preview") !== null) return null;
  const resolved = element.closest<HTMLElement>("[data-preview-path]");
  if (resolved !== null) {
    const path = resolved.dataset["previewPath"] ?? "";
    return path === "" ? null : { element: resolved, target: { kind: "wiki", raw: path } };
  }
  const wiki = element.closest<HTMLElement>("[data-wiki-target]");
  if (wiki !== null) {
    const raw = wiki.dataset["wikiTarget"] ?? "";
    return raw === "" ? null : { element: wiki, target: { kind: "wiki", raw } };
  }
  const anchor = element.closest("a[href]");
  const href = anchor?.getAttribute("href") ?? "";
  if (anchor === null || href === "" || hasUrlScheme(href)) return null;
  return { element: anchor, target: { kind: "md", raw: href } };
}

/**
 * 把链接原文拆成解析目标与锚点。
 *
 * @param from 宿主笔记路径；纯锚点（`#小节`）预览宿主自身。
 * @returns Markdown 锚点按 URL 规则解码；wiki 锚点保持原文。
 */
export function previewRequestOf(
  { kind, raw }: PreviewTarget,
  from: string,
): { kind: "wiki" | "md"; target: string; anchor: string | null } {
  const hash = raw.indexOf("#");
  const target = hash < 0 ? raw : raw.slice(0, hash);
  const fragment = hash < 0 ? "" : raw.slice(hash + 1);
  let anchor: string | null = fragment === "" ? null : fragment;
  if (anchor !== null && kind === "md") {
    try {
      anchor = decodeURIComponent(anchor);
    } catch {
      // 非法百分号编码按原文匹配标题。
    }
  }
  if (target === "") return { kind: "wiki", target: from, anchor };
  return { kind, target, anchor };
}
