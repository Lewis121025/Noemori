/**
 * 正文、笔记嵌入与悬停预览共享节点渲染；嵌入不把目标内容写入宿主文档。
 *
 * 嵌套控制在这一层执行（解析层始终产出完整结构）：
 *
 * - 深度上限 [`EMBED_DEPTH_LIMIT`]：宿主文档的直接嵌入是第 1 层；
 * - 环检测：目标已出现在祖先链上时停止展开，给出可见原因。
 *
 * 两种情况都渲染占位说明而不是静默截断，标题按钮始终可以打开原文。
 * 编辑器视图在确认节点仍挂载后才创建，卸载发生在读取期间就不会留下游离视图。
 */

import type { Node as PmNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView, type NodeViewConstructor } from "prosemirror-view";
import { resolveMediaUrl, type MediaIo } from "../../preview/media";
import { parseMarkdown } from "../../../shared/markdown/parse";
import { sliceEmbed } from "../../../shared/markdown/block-anchor";
import { documentAccess } from "../../editor/read-only";
import { frontmatterPresentation, frontmatterSourceView } from "../../editor/frontmatter";
import { linkInteraction, type OpenContentLink } from "../../editor/links/link-interaction";
import { mathNodeViews } from "./math-view";
import { createHtmlNodeViews } from "./html-view";
import { createImageNodeViews } from "./image-view";
import { createPdfNodeViews } from "./pdf-view";
import { createPlayerNodeViews } from "./media-view";
import { createWebPageNodeViews } from "./webpage-view";
import { taskItemView } from "./task-view";
import {
  calloutNodeViews,
  calloutRevealPlugin,
  commentNodeViews,
  createCodeBlockViews,
  footnoteNavigation,
} from "./dialect-view";
import "../../styles/content.css";
import { isWhiteboardPath } from "../../../shared/whiteboard/model";
import { mountWhiteboardPreview } from "../../whiteboard/embed-preview";

/**
 * 装配完整内容渲染器；资源与链接始终以该表面的笔记路径为基准。
 * @param from 当前内容所属的库内路径。
 * @param openLink 带来源路径的导航回调，保留宿主的死链、歧义与版本检查。
 * @param io 库内媒体访问能力；节点负责释放资源和取消过期渲染。
 * @param depth 嵌入深度，正文为 0。
 * @param chain 已展开路径，用于循环检测。
 * @returns 正文与只读预览共用的节点视图集合。
 */
export function createContentNodeViews(
  from: string,
  openLink: OpenContentLink,
  io: MediaIo,
  depth = 0,
  chain: readonly string[] = [from],
): Record<string, NodeViewConstructor> {
  const open = (kind: "wiki" | "md", raw: string) => openLink(kind, raw, from);
  return {
    markdown_block: frontmatterSourceView,
    list_item: taskItemView,
    ...mathNodeViews,
    ...commentNodeViews,
    ...calloutNodeViews,
    ...createCodeBlockViews(),
    ...createHtmlNodeViews((src) => resolveMediaUrl(from, src, "md", io)),
    ...createImageNodeViews((src, kind) => resolveMediaUrl(from, src, kind, io)),
    ...createPdfNodeViews(from, open, io),
    ...createPlayerNodeViews(from, io),
    ...createWebPageNodeViews(io.webPages, (url) => open("md", url)),
    ...createNoteEmbedViews(from, openLink, io, depth, chain),
  };
}

/** 嵌入嵌套上限（宿主文档的直接嵌入算第 1 层）。 */
const EMBED_DEPTH_LIMIT = 3;

/** 取消为 null，失败携带说明；白板只解析路径，由自己的预览生命周期先订阅再读取。 */
type LoadedEmbed =
  | { kind: "markdown"; doc: PmNode; path: string }
  | { kind: "whiteboard"; path: string }
  | { message: string };

/** 一次只读笔记渲染的目标与上下文；嵌入块与悬停预览共用。 */
export type NotePreviewRequest = {
  /** 宿主笔记的库内路径，用于解析相对目标。 */
  from: string;
  /** 链接目标（不含锚点）。 */
  target: string;
  /** 目标语法；嵌入恒为 wiki，悬停可能是 Markdown 链接。 */
  kind: "wiki" | "md";
  /** 标题或 `^块` 锚点；整篇为 null。 */
  anchor: string | null;
  /** 打开嵌套嵌入标题时沿用工作区的链接处理。 */
  openLink: OpenContentLink;
  io: MediaIo;
  /** 宿主视图自身的嵌套深度。 */
  depth: number;
  /** 已解析的祖先路径链（含宿主），用于环检测。 */
  chain: readonly string[];
};

/**
 * 把目标笔记（或其中一节）只读渲染进容器。
 *
 * 读取中的占位由调用方预先放入容器；失败显示原因。返回的 destroy 取消迟到的读取并释放嵌套视图。
 */
export function mountNotePreview(
  body: HTMLElement,
  request: NotePreviewRequest,
): { destroy: () => void } {
  let view: EditorView | null = null;
  let cancelled = false;
  let boardPreview: { destroy: () => void } | null = null;
  void loadEmbed(request, () => cancelled)
    .then((loaded) => {
      if (loaded === null || cancelled) return;
      if ("message" in loaded) {
        body.textContent = loaded.message;
        return;
      }
      body.textContent = "";
      if (loaded.kind === "whiteboard") {
        boardPreview = mountWhiteboardPreview(body, loaded.path, request.io, () =>
          request.openLink(request.kind, request.target, request.from),
        );
        return;
      }
      view = new EditorView(body, {
        // 悬停事件会冒泡到宿主；路径归属必须留在各自的内容根节点上。
        attributes: { "data-content-path": loaded.path },
        state: EditorState.create({
          doc: loaded.doc,
          plugins: [
            documentAccess(true),
            frontmatterPresentation(),
            linkInteraction((kind, raw) => request.openLink(kind, raw, loaded.path)),
            calloutRevealPlugin(),
            footnoteNavigation(),
          ],
        }),
        nodeViews: createContentNodeViews(
          loaded.path,
          request.openLink,
          request.io,
          request.depth + 1,
          [...request.chain, loaded.path],
        ),
      });
    })
    .catch((error: unknown) => {
      if (!cancelled)
        body.textContent = `无法创建预览：${error instanceof Error ? error.message : String(error)}`;
    });
  return {
    destroy() {
      cancelled = true;
      boardPreview?.destroy();
      view?.destroy();
      view = null;
    },
  };
}

/**
 * 创建笔记嵌入的节点视图。
 *
 * @param from 宿主笔记的库内路径，用于解析相对目标。
 * @param openLink 点击标题时按普通 wiki 链接打开，死链和歧义沿用工作区的处理。
 * @param io 解析与读取目标文件；失败只显示在嵌入块内。
 * @param depth 宿主视图自身的嵌套深度；文档表面传 0。
 * @param chain 已解析的祖先路径链（含宿主），用于环检测。
 * @returns 不修改宿主文档的节点视图。
 */
function createNoteEmbedViews(
  from: string,
  openLink: OpenContentLink,
  io: MediaIo,
  depth: number,
  chain: readonly string[],
): Record<string, NodeViewConstructor> {
  return {
    note_embed(node) {
      const target = String(node.attrs["target"] ?? "");
      const anchor = typeof node.attrs["anchor"] === "string" ? node.attrs["anchor"] : null;
      const alias = typeof node.attrs["alias"] === "string" ? node.attrs["alias"] : "";
      const raw = anchor === null || anchor === "" ? target : `${target}#${anchor}`;
      const dom = document.createElement("div");
      dom.contentEditable = "false";
      dom.style.margin = "0.75rem 0";
      dom.style.padding = "0.5rem 0.75rem";
      dom.style.border = "1px solid var(--border)";
      dom.style.borderRadius = "0.75rem";
      const header = document.createElement("button");
      header.type = "button";
      header.className = "reader-button";
      header.textContent = alias !== "" ? alias : raw;
      header.addEventListener("click", () => openLink("wiki", raw, from));
      const body = document.createElement("div");
      body.style.marginTop = "0.35rem";
      body.textContent = "正在嵌入…";
      dom.append(header, body);
      const preview = mountNotePreview(body, {
        from,
        target,
        kind: "wiki",
        anchor,
        openLink,
        io,
        depth,
        chain,
      });
      return {
        dom,
        destroy: preview.destroy,
        ignoreMutation: () => true,
        stopEvent: () => true,
      };
    },
  };
}

async function loadEmbed(
  { io, from, target, kind, anchor, depth, chain }: NotePreviewRequest,
  cancelled: () => boolean,
): Promise<LoadedEmbed | null> {
  try {
    if (depth + 1 > EMBED_DEPTH_LIMIT)
      return { message: `嵌套嵌入已达上限（${EMBED_DEPTH_LIMIT} 层），点击标题打开原文` };
    const path = await io.resolveLink(from, target, kind);
    if (cancelled()) return null;
    if (path === null) return { message: "无法嵌入：目标不存在或同名歧义" };
    if (chain.includes(path)) return { message: "检测到循环嵌入，已停止展开；点击标题打开原文" };
    if (isWhiteboardPath(path)) {
      if (anchor !== null && anchor !== "")
        return { message: "白板暂不支持局部锚点，请打开完整白板" };
      return { kind: "whiteboard", path };
    }
    const bytes = await io.readFile(path);
    if (cancelled()) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const doc = sliceEmbed(parseMarkdown(text), anchor);
    if (cancelled()) return null;
    if (doc === null) return { message: anchor?.startsWith("^") ? "未找到块" : "未找到标题" };
    return { kind: "markdown", doc, path };
  } catch {
    return cancelled() ? null : { message: "无法嵌入此笔记" };
  }
}
