<script lang="ts">
  /**
   * 图谱画布：布局交给布局引擎分帧计算，这里只负责绘制与指针交互。
   *
   * 滚轮以指针为中心缩放，拖动空白处平移，悬停高亮邻居，单击节点打开。
   * 图变化时沿用已有节点的坐标重新布局；用户动过视口后不再自动适配。
   */
  import { onMount, untrack } from "svelte";
  import type { GraphNode, VaultGraph } from "../../shared/api";
  import type { LayoutEngine } from "./layout-client";
  import { PositionMemory } from "./layout";
  import { neighborMap } from "./model";
  import { drawGraph, nodeRadius, resolvePalette, type GraphPalette } from "./render";
  import { fitViewport, hitNode, zoomAt, type Viewport } from "./viewport";

  let {
    graph,
    current,
    engine,
    label,
    onOpen,
  }: {
    /** 要显示的图（已过滤）。 */
    graph: VaultGraph;
    /** 当前笔记路径；以强调色标出。 */
    current: string | null;
    engine: LayoutEngine;
    /** 画布的无障碍名称。 */
    label: string;
    onOpen: (node: GraphNode) => void;
  } = $props();

  let container: HTMLElement;
  let canvas: HTMLCanvasElement;
  let width = $state(0);
  let height = $state(0);
  let hovered = $state(-1);
  let settling = $state(false);
  let failure = $state<string | null>(null);
  // 绘制状态不走响应式：每帧坐标都会整体替换，按需在 requestAnimationFrame 里重画。
  let positions: Float32Array = new Float32Array(0);
  let view: Viewport = { x: 0, y: 0, k: 1 };
  let userMoved = false;
  let frame = 0;
  let cancel: (() => void) | null = null;
  /** 跨过滤与增量刷新保留坐标，让熟悉的布局不被打乱。 */
  const memory = new PositionMemory();

  const indexOf = $derived(new Map(graph.nodes.map((node, index) => [node.path, index])));
  const neighbors = $derived(neighborMap(graph));
  const links = $derived.by(() => {
    const out = new Uint32Array(graph.edges.length * 2);
    for (const [index, edge] of graph.edges.entries()) {
      out[index * 2] = indexOf.get(edge.from) ?? 0;
      out[index * 2 + 1] = indexOf.get(edge.to) ?? 0;
    }
    return out;
  });
  const radii = $derived(
    Float32Array.from(graph.nodes, (node) => nodeRadius(neighbors.get(node.path)?.size ?? 0)),
  );
  const focus = $derived.by((): ReadonlySet<number> => {
    const node = graph.nodes[hovered];
    if (node === undefined) return new Set();
    const around = [...(neighbors.get(node.path) ?? [])].flatMap((path) => {
      const index = indexOf.get(path);
      return index === undefined ? [] : [index];
    });
    return new Set([hovered, ...around]);
  });

  /** 解析后的主题色；明暗切换时重新解析。 */
  let palette: GraphPalette | null = null;

  function schedule(): void {
    if (frame === 0) frame = requestAnimationFrame(draw);
  }

  function draw(): void {
    frame = 0;
    if (width === 0 || height === 0 || positions.length !== graph.nodes.length * 2) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (context === null) return;
    drawGraph(
      context,
      {
        positions,
        radii,
        links,
        titles: graph.nodes.map((node) => node.title),
        dead: graph.nodes.map((node) => node.dead),
        current: current === null ? -1 : (indexOf.get(current) ?? -1),
        hovered,
        focus,
      },
      view,
      (palette ??= resolvePalette(container)),
      width,
      height,
      ratio,
    );
  }

  function layout(next: VaultGraph): void {
    cancel?.();
    const count = next.nodes.length;
    const paths = next.nodes.map((node) => node.path);
    const seeds = memory.seeds(paths);
    positions = seeds.map((value) => (Number.isNaN(value) ? 0 : value));
    hovered = -1;
    failure = null;
    settling = count > 0;
    if (count === 0) {
      schedule();
      return;
    }
    cancel = engine.run(
      { count, links: links.slice(), seeds },
      (frameAt, done) => {
        positions = frameAt;
        memory.remember(paths, frameAt);
        if (!userMoved) view = fitViewport(positions, width, height);
        if (done) {
          settling = false;
          cancel = null;
        }
        schedule();
      },
      (message) => {
        failure = `布局失败：${message}`;
        settling = false;
        cancel = null;
      },
    );
  }

  $effect(() => {
    const next = graph;
    untrack(() => layout(next));
  });

  $effect(() => {
    void hovered;
    void current;
    void width;
    void height;
    schedule();
  });

  /** 回到全图适配视口；之后的布局帧重新自动适配。 */
  function fit(): void {
    userMoved = false;
    view = fitViewport(positions, width, height);
    schedule();
  }

  function local(event: MouseEvent): [number, number] {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  let press: { x: number; y: number; moved: boolean; node: number; view: Viewport } | null = null;

  function pointerdown(event: PointerEvent): void {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = local(event);
    press = { x, y, moved: false, node: hitNode(view, positions, radii, x, y), view };
  }

  function pointermove(event: PointerEvent): void {
    const [x, y] = local(event);
    if (press === null) {
      hovered = hitNode(view, positions, radii, x, y);
      return;
    }
    const dx = x - press.x;
    const dy = y - press.y;
    if (!press.moved && Math.hypot(dx, dy) > 4) press.moved = true;
    if (press.moved && press.node < 0) {
      view = { ...press.view, x: press.view.x + dx, y: press.view.y + dy };
      userMoved = true;
      schedule();
    }
  }

  function pointerup(): void {
    const released = press;
    press = null;
    if (released === null || released.moved || released.node < 0) return;
    const node = graph.nodes[released.node];
    if (node !== undefined) onOpen(node);
  }

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      if (!userMoved) view = fitViewport(positions, width, height);
    });
    resize.observe(container);
    // 非被动监听：滚轮缩放必须阻止页面滚动。
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const [x, y] = local(event);
      view = zoomAt(view, Math.exp(-event.deltaY * 0.002), x, y);
      userMoved = true;
      schedule();
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => {
      palette = null;
      schedule();
    };
    scheme.addEventListener("change", retheme);
    return () => {
      resize.disconnect();
      canvas.removeEventListener("wheel", wheel);
      scheme.removeEventListener("change", retheme);
      cancel?.();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  });
</script>

<figure class="graph-canvas" aria-label={label} bind:this={container}>
  <canvas
    bind:this={canvas}
    class:pointing={hovered >= 0}
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerup={pointerup}
    onpointercancel={() => {
      press = null;
    }}
    onpointerleave={() => {
      if (press === null) hovered = -1;
    }}
  ></canvas>
  <div class="overlay">
    {#if failure !== null}
      <span class="status" role="alert">{failure}</span>
    {:else if settling}
      <span class="status">正在布局…</span>
    {/if}
    {#if graph.nodes[hovered] !== undefined}
      <span class="status hovered">{graph.nodes[hovered]?.title}</span>
    {/if}
    <button type="button" class="fit" title="适配视图" aria-label="适配视图" onclick={fit}
      ><svg viewBox="0 0 20 20" aria-hidden="true"
        ><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" /></svg
      ></button
    >
  </div>
</figure>

<style>
  .graph-canvas {
    margin: 0;
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    border-radius: 0.5rem;
    background: var(--bg);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: grab;
  }
  canvas:active {
    cursor: grabbing;
  }
  canvas.pointing {
    cursor: pointer;
  }
  .overlay {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    pointer-events: none;
  }
  .status {
    color: var(--muted);
    font-size: 0.75rem;
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    padding: 0.15rem 0.4rem;
    border-radius: 0.3rem;
  }
  .status[role="alert"] {
    color: var(--danger);
  }
  .hovered {
    color: var(--fg);
  }
  .fit {
    pointer-events: auto;
    display: flex;
    padding: 0.3rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg);
    color: var(--muted);
    cursor: pointer;
  }
  .fit:hover {
    color: var(--fg);
  }
  svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
