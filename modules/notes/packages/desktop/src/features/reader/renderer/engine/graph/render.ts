/**
 * 图谱的 Canvas 2D 绘制。
 *
 * 绘制只读场景快照，不持有状态；悬停高亮与当前笔记由调用方算好下标传入。
 * 节点多时只给高亮节点画标签，避免文字糊成一片。
 */

import type { Viewport } from "./viewport";

/** 绘制所需的主题色；取自 CSS 变量，随明暗主题变化。 */
export type GraphPalette = {
  readonly node: string;
  readonly accent: string;
  readonly muted: string;
  readonly edge: string;
  readonly label: string;
  readonly background: string;
};

/** 一帧场景。 */
export type GraphScene = {
  readonly positions: Float32Array;
  readonly radii: Float32Array;
  /** 边的端点下标，交错排列。 */
  readonly links: Uint32Array;
  readonly titles: readonly string[];
  readonly dead: readonly boolean[];
  /** 当前笔记的下标；-1 表示不在图里。 */
  readonly current: number;
  /** 悬停节点的下标；-1 表示没有悬停。 */
  readonly hovered: number;
  /** 悬停节点及其邻居；为空时不做淡化。 */
  readonly focus: ReadonlySet<number>;
};

/** 节点数不超过这个值时，缩放足够大就给所有节点画标签。 */
const LABEL_ALL_LIMIT = 400;

/**
 * 按视口绘制一帧。
 *
 * @param width 画布 CSS 宽度。
 * @param height 画布 CSS 高度。
 * @param ratio 设备像素比。
 */
export function drawGraph(
  context: CanvasRenderingContext2D,
  scene: GraphScene,
  view: Viewport,
  palette: GraphPalette,
  width: number,
  height: number,
  ratio: number,
): void {
  const { positions, radii, links, focus } = scene;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);
  context.setTransform(ratio * view.k, 0, 0, ratio * view.k, ratio * view.x, ratio * view.y);
  const dimmed = focus.size > 0;

  context.lineWidth = 1 / view.k;
  context.strokeStyle = palette.edge;
  context.globalAlpha = dimmed ? 0.12 : 0.5;
  context.beginPath();
  for (let index = 0; index + 1 < links.length; index += 2) {
    const from = links[index]!;
    const to = links[index + 1]!;
    if (
      dimmed &&
      focus.has(from) &&
      focus.has(to) &&
      (from === scene.hovered || to === scene.hovered)
    )
      continue;
    context.moveTo(positions[from * 2]!, positions[from * 2 + 1]!);
    context.lineTo(positions[to * 2]!, positions[to * 2 + 1]!);
  }
  context.stroke();
  if (dimmed) {
    context.globalAlpha = 0.9;
    context.strokeStyle = palette.accent;
    context.lineWidth = 1.5 / view.k;
    context.beginPath();
    for (let index = 0; index + 1 < links.length; index += 2) {
      const from = links[index]!;
      const to = links[index + 1]!;
      if (from !== scene.hovered && to !== scene.hovered) continue;
      context.moveTo(positions[from * 2]!, positions[from * 2 + 1]!);
      context.lineTo(positions[to * 2]!, positions[to * 2 + 1]!);
    }
    context.stroke();
  }

  for (let index = 0; index < radii.length; index += 1) {
    const x = positions[index * 2]!;
    const y = positions[index * 2 + 1]!;
    context.globalAlpha = dimmed && !focus.has(index) ? 0.15 : 1;
    context.beginPath();
    context.arc(x, y, radii[index]!, 0, Math.PI * 2);
    if (scene.dead[index]) {
      context.lineWidth = 1 / view.k;
      context.strokeStyle = palette.muted;
      context.stroke();
    } else {
      context.fillStyle =
        index === scene.current || index === scene.hovered ? palette.accent : palette.node;
      context.fill();
    }
  }

  const labelAll = radii.length <= LABEL_ALL_LIMIT && view.k >= 0.7;
  context.font = `${12 / view.k}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillStyle = palette.label;
  for (let index = 0; index < radii.length; index += 1) {
    const highlighted = focus.has(index) || index === scene.current;
    if (!highlighted && !labelAll) continue;
    context.globalAlpha = dimmed && !focus.has(index) ? 0.15 : 1;
    context.fillText(
      scene.titles[index] ?? "",
      positions[index * 2]!,
      positions[index * 2 + 1]! + radii[index]! + 3 / view.k,
    );
  }
  context.globalAlpha = 1;
}

/**
 * 在 `host` 的主题上下文里把 CSS 颜色变量解析成具体颜色。
 *
 * 主题变量写成 `light-dark(…)`，`getPropertyValue` 只给原文，Canvas 不认识，
 * 会静默退回黑色；借一个探针元素让浏览器按当前配色方案算出 `rgb(…)`。
 */
export function resolvePalette(host: HTMLElement): GraphPalette {
  const probe = document.createElement("span");
  probe.style.display = "none";
  host.append(probe);
  const read = (name: string) => {
    probe.style.color = `var(${name})`;
    return getComputedStyle(probe).color;
  };
  const palette: GraphPalette = {
    node: read("--muted"),
    accent: read("--accent"),
    muted: read("--muted"),
    edge: read("--muted"),
    label: read("--fg"),
    background: read("--bg"),
  };
  probe.remove();
  return palette;
}

/** 节点半径：随度数增长，但开平方压缩，避免枢纽笔记盖住整片区域。 */
export function nodeRadius(degree: number): number {
  return 3 + Math.sqrt(degree) * 1.6;
}
