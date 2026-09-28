import type { WhiteboardDocument } from "./model";
import { inkBounds, strokePath } from "./geometry";

/**
 * 创建同一份矢量笔迹的轻量预览，不挂载编辑器，也不访问磁盘。
 * @param board 已校验的白板快照。
 * @returns 可缩放的 SVG；只写入数值路径，不解释文件中的 HTML。
 */
export function createWhiteboardPreview(board: WhiteboardDocument): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const bounds = inkBounds(board.strokes) ?? { x: 0, y: 0, width: 640, height: 300 };
  svg.setAttribute(
    "viewBox",
    `${bounds.x - 24} ${bounds.y - 24} ${Math.max(100, bounds.width + 48)} ${Math.max(100, bounds.height + 48)}`,
  );
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    board.strokes.length === 0 ? "空白白板" : `白板预览，${board.strokes.length} 条笔迹`,
  );
  svg.classList.add("whiteboard-preview");
  svg.style.cssText = "display:block;width:100%;height:240px;color:var(--fg);background:var(--bg)";
  for (const stroke of board.strokes) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", strokePath(stroke.points));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", String(stroke.width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  if (board.strokes.length === 0) {
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", "320");
    label.setAttribute("y", "150");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "currentColor");
    label.textContent = "打开白板，开始写画";
    svg.append(label);
  }
  return svg;
}

/**
 * Svelte action 独占预览容器的子节点，与编辑器嵌入复用同一渲染器。
 * @param host 不含 Svelte 子节点的预览容器。
 * @param board 当前白板内容；更新只替换只读 SVG，不创建编辑会话。
 * @returns 响应内容变化的更新入口。
 */
export function whiteboardPreview(host: HTMLElement, board: WhiteboardDocument) {
  const update = (next: WhiteboardDocument) => host.replaceChildren(createWhiteboardPreview(next));
  update(board);
  return { update };
}
