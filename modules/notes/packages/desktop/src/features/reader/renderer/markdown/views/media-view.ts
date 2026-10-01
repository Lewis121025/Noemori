/**
 * 音视频嵌入：浏览器原生播放器，库内文件经 `noemori-vault://` 流式协议按区间读取。
 *
 * 不把文件读进内存：大视频也能立即开始播放并拖动进度。远程地址原样使用。
 * 视图只改 DOM，不提交文档事务。
 */
import type { NodeViewConstructor } from "prosemirror-view";
import { isRemoteMediaSrc, vaultMediaUrl, type MediaIo, type MediaKind } from "../../preview/media";

/**
 * 解析播放器地址。
 *
 * @returns 可赋给 `<audio>`/`<video>` 的地址；目标不存在、歧义或解析失败时为 null。
 */
export async function playerSource(
  from: string,
  src: string,
  kind: MediaKind,
  io: Pick<MediaIo, "resolveLink">,
): Promise<string | null> {
  const trimmed = src.trim();
  if (trimmed === "") return null;
  if (isRemoteMediaSrc(trimmed)) return trimmed;
  try {
    const rel = await io.resolveLink(from, trimmed, kind);
    return rel === null ? null : vaultMediaUrl(rel);
  } catch {
    return null;
  }
}

/**
 * 创建音视频节点视图。
 *
 * @param from 当前笔记路径，用于解析相对地址。
 * @param io 链接解析能力；只用于把引用解析成库内路径。
 */
export function createPlayerNodeViews(
  from: string,
  io: Pick<MediaIo, "resolveLink">,
): Record<string, NodeViewConstructor> {
  const create =
    (tag: "audio" | "video"): NodeViewConstructor =>
    (node) => {
      const src = String(node.attrs["src"] ?? "");
      const kind: MediaKind = node.attrs["kind"] === "wiki" ? "wiki" : "md";
      const dom = document.createElement("span");
      dom.contentEditable = "false";
      dom.className = `media-embed media-${tag}`;
      const player = document.createElement(tag);
      player.controls = true;
      player.preload = "metadata";
      const alt = String(node.attrs["alt"] ?? "");
      if (alt !== "") player.setAttribute("aria-label", alt);
      dom.textContent = "正在载入…";
      let cancelled = false;
      void playerSource(from, src, kind, io).then((url) => {
        if (cancelled) return;
        if (url === null) {
          dom.textContent = `无法播放：${src}`;
          return;
        }
        player.src = url;
        dom.replaceChildren(player);
      });
      return {
        dom,
        update: (next) => next.sameMarkup(node),
        stopEvent: () => true,
        ignoreMutation: () => true,
        destroy() {
          cancelled = true;
          // 释放解码器与网络连接；只移除 src 不足以让浏览器立即停止读取。
          player.pause();
          player.removeAttribute("src");
          player.load();
        },
      };
    };
  return { audio: create("audio"), video: create("video") };
}
