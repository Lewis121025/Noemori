import { mount, unmount } from "svelte";
import type { NodeViewConstructor } from "prosemirror-view";
import PdfEmbed from "../../components/previews/PdfEmbed.svelte";
import type { MediaKind, MediaIo } from "../media/media";
import { observeViewport } from "./viewport";

/**
 * 只为进入视口的 PDF 嵌入创建阅读器，离开后销毁解析任务和画布。
 * @param from 当前笔记路径，用于解析附件。
 * @param onOpen 在主区域打开附件的回调。
 * @param io 由阅读器注入的资源访问能力，不依赖全局桥接。
 * @returns 不修改文档内容的 PDF 节点视图。
 */
export function createPdfNodeViews(
  from: string,
  onOpen: (kind: MediaKind, src: string) => void,
  io: Pick<MediaIo, "resolveLink" | "readFile">,
): Record<string, NodeViewConstructor> {
  return {
    pdf(node) {
      const src = String(node.attrs["src"] ?? "");
      const kind = node.attrs["kind"] === "wiki" ? "wiki" : "md";
      const dom = document.createElement("span");
      dom.contentEditable = "false";
      dom.style.display = "inline-block";
      dom.style.width = "100%";
      dom.style.minHeight = "28rem";
      dom.textContent = src;
      let component: ReturnType<typeof mount> | null = null;
      const clear = (): void => {
        if (component !== null) void unmount(component);
        component = null;
      };
      const stop = observeViewport(dom, (visible) => {
        if (visible && component === null) {
          dom.replaceChildren();
          component = mount(PdfEmbed, {
            target: dom,
            props: { from, src, kind, io, onOpen: () => onOpen(kind, src) },
          });
        } else if (!visible) {
          clear();
          dom.textContent = src;
        }
      });
      return {
        dom,
        update: (next) => node.sameMarkup(next),
        stopEvent: () => true,
        ignoreMutation: () => true,
        destroy() {
          stop();
          clear();
        },
      };
    },
  };
}
