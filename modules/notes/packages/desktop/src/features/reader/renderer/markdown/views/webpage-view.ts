import type { NodeViewConstructor } from "prosemirror-view";
import type { WebPageHost } from "../../preview/webpage-host";
import type { WebPageAction } from "../../../shared/webpage";

/**
 * 正文只承载地址栏和网页占位，实时网页由独立的沙箱视图绘制。
 * @param pages 主窗口网页挂载器；静态内容预览可以不提供。
 * @param open 点击当前地址时按普通外链打开。
 * @returns 不把浏览状态写回笔记的网页节点视图。
 */
export function createWebPageNodeViews(
  pages: WebPageHost | undefined,
  open: (url: string) => void,
): Record<string, NodeViewConstructor> {
  return {
    webpage(node) {
      const url = String(node.attrs["url"]);
      let currentUrl = url;
      const dom = document.createElement("div");
      dom.className = "webpage-embed";
      dom.contentEditable = "false";
      const toolbar = document.createElement("div");
      toolbar.className = "webpage-toolbar";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", "网页浏览工具");
      const surface = document.createElement("div");
      surface.className = "webpage-surface";
      surface.style.height = `${String(node.attrs["height"])}px`;
      surface.setAttribute("aria-label", `网页 ${url}`);
      surface.textContent = pages ? "正在加载网页…" : "此预览未提供网页浏览能力";
      const address = document.createElement("button");
      address.type = "button";
      address.className = "webpage-address";
      address.textContent = url;
      address.title = url;
      address.addEventListener("click", () => open(currentUrl));
      let mounted: ReturnType<WebPageHost["mount"]> | undefined;
      function control(action: WebPageAction, label: string): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "reader-button";
        button.textContent = action === "back" ? "←" : action === "forward" ? "→" : "↻";
        button.setAttribute("aria-label", label);
        button.disabled = action !== "reload" || !pages;
        button.addEventListener("click", () => {
          if (mounted && pages)
            void pages.action(mounted.id, action).catch((error: unknown) => {
              surface.textContent = `网页操作失败：${error instanceof Error ? error.message : String(error)}`;
            });
        });
        return button;
      }
      const back = control("back", "网页后退");
      const forward = control("forward", "网页前进");
      const reload = control("reload", "重新加载网页");
      let focused = false;
      toolbar.append(back, forward, reload, address);
      dom.append(toolbar, surface);
      if (pages)
        mounted = pages.mount(surface, url, (state) => {
          currentUrl = state.url;
          if (state.focused && !focused)
            dom.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
          focused = state.focused;
          const label = state.title ? `${state.title} · ${state.url}` : state.url;
          if (address.textContent !== label) address.textContent = label;
          if (address.title !== state.url) address.title = state.url;
          back.disabled = !state.canBack;
          forward.disabled = !state.canForward;
          const status = state.error ?? (state.loading ? "正在加载网页…" : "");
          if (surface.textContent !== status) surface.textContent = status;
        });
      return {
        dom,
        update: (next) => next.sameMarkup(node),
        stopEvent: () => true,
        ignoreMutation: () => true,
        destroy: () => mounted?.destroy(),
      };
    },
  };
}
