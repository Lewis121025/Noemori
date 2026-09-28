/** HTML 预览只负责消毒和图片资源，源码编辑与预览取消共用 SourceNodeView。 */
import type { NodeViewConstructor } from "prosemirror-view";
import { sanitizeHtml } from "./html";
import { rewriteMediaSrcs } from "../media/media";
import { SourceNodeView } from "./source-node-view";

/**
 * 为行内和块级 HTML 创建同一套节点视图。
 *
 * @param loadMedia 将 HTML 的相对图片地址转换为可加载 URL；每个 blob URL 由本预览释放。
 * @returns 两种 HTML 节点的构造器；预览失败不改变原始 HTML 与编辑器文档。
 */
export function createHtmlNodeViews(
  loadMedia: (src: string) => Promise<string | null>,
): Record<string, NodeViewConstructor> {
  const create: NodeViewConstructor = (node, view, getPos, decorations) =>
    new SourceNodeView(
      node,
      view,
      getPos,
      {
        kind: "html",
        render(dom, html, _display, signal) {
          const blobs = new Set<string>();
          signal.addEventListener(
            "abort",
            () => {
              for (const url of blobs) URL.revokeObjectURL(url);
              blobs.clear();
            },
            { once: true },
          );
          dom.replaceChildren(sanitizeHtml(html));
          void rewriteMediaSrcs(dom, async (src) => {
            if (signal.aborted) return null;
            const url = await loadMedia(src);
            if (url !== null && url.startsWith("blob:")) {
              // 已完成与迟到的资源都归本次预览，不能等其他图片加载完才开始管理。
              if (signal.aborted) URL.revokeObjectURL(url);
              else blobs.add(url);
            }
            return signal.aborted ? null : url;
          });
        },
      },
      decorations,
    );
  return { html_inline: create, html_block: create };
}
