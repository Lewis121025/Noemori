<script lang="ts">
  /**
   * 图谱面板：读取索引、过滤并交给画布。全局图谱与局部图谱共用。
   *
   * 库每次变更后按索引版本防抖重读，已有节点保留坐标，只有新节点需要找位置。
   */
  import { onDestroy, untrack } from "svelte";
  import type { GraphNode, VaultGraph } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { createWorkerLayout, type LayoutEngine } from "./layout-client";
  import { filterGraph, graphEquals, localGraph } from "./model";
  import GraphCanvas from "./GraphCanvas.svelte";

  let {
    workspace,
    center,
    engine: provided,
    onOpen,
  }: {
    workspace: ReaderWorkspaceController;
    /** 局部图谱的中心笔记；`null` 表示全局图谱。 */
    center: string | null;
    /** 布局引擎；缺省时由面板创建 Worker 并在卸载时释放。 */
    engine?: LayoutEngine;
    onOpen: (node: GraphNode) => void;
  } = $props();

  /** 库变更后的重读防抖；连续保存只触发一次重读。 */
  const RELOAD_DELAY_MS = 400;

  const engine = untrack(() => provided) ?? createWorkerLayout();
  const ownsEngine = untrack(() => provided) === undefined;
  let raw = $state.raw<VaultGraph | null>(null);
  let error = $state<string | null>(null);
  let query = $state("");
  let showOrphans = $state(true);
  let showDead = $state(false);
  let depth = $state(1);
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadedDead: boolean | null = null;
  const inventory = $derived(raw?.nodes.map((node) => node.path) ?? []);

  const shown = $derived.by(() => {
    if (raw === null) return null;
    const filter = { query, showOrphans };
    return center === null
      ? filterGraph(raw, filter)
      : filterGraph(localGraph(raw, center, depth), filter, center);
  });

  async function load(includeDead: boolean): Promise<void> {
    const id = ++request;
    const result = await workspace.loadGraph(includeDead);
    if (id !== request) return;
    loadedDead = includeDead;
    error = result.error;
    if (result.graph !== null && (raw === null || !graphEquals(raw, result.graph)))
      raw = result.graph;
  }

  $effect(() => {
    void workspace.indexRevision;
    const includeDead = showDead;
    untrack(() => {
      clearTimeout(timer);
      // 首次与切换死链时立即读；库变更触发的重读防抖。
      if (loadedDead !== includeDead) void load(includeDead);
      else timer = setTimeout(() => void load(includeDead), RELOAD_DELAY_MS);
    });
  });

  onDestroy(() => {
    clearTimeout(timer);
    request += 1;
    if (ownsEngine) engine.dispose();
  });

  /** 回车打开过滤结果里的第一篇（局部图谱跳过中心自身）。 */
  function openFirst(): void {
    const target = shown?.nodes.find((node) => node.path !== center);
    if (target !== undefined) onOpen(target);
  }
</script>

<div class="graph-panel" class:local={center !== null}>
  <div class="controls">
    <input
      type="search"
      class="reader-input"
      aria-label="过滤图谱"
      placeholder="按文件名过滤，tag: 按标签"
      bind:value={query}
      onkeydown={(event) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          openFirst();
        }
      }}
    />
    {#if center !== null}
      <label>
        深度
        <select class="reader-input" aria-label="局部图谱深度" bind:value={depth}>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>
      </label>
    {/if}
    <label><input type="checkbox" bind:checked={showOrphans} />孤立笔记</label>
    <label><input type="checkbox" bind:checked={showDead} />未创建的笔记</label>
    {#if shown !== null}
      <span class="stats" aria-live="polite"
        >{shown.nodes.length} 个节点 · {shown.edges.length} 条链接</span
      >
    {/if}
  </div>
  {#if error !== null}
    <p class="status" role="alert">{error}</p>
  {/if}
  {#if shown === null}
    {#if error === null}<p class="status">正在读取图谱…</p>{/if}
  {:else if shown.nodes.length === 0}
    <p class="status">没有符合条件的笔记。</p>
  {:else}
    <div class="stage">
      <GraphCanvas
        graph={shown}
        {inventory}
        vaultRoot={workspace.vaultRoot}
        current={center ?? workspace.document.path}
        {engine}
        label={center === null ? "全库关系图谱" : "本文局部关系图谱"}
        {onOpen}
      />
    </div>
  {/if}
</div>

<style>
  .graph-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
    height: 100%;
  }
  .graph-panel.local {
    height: 20rem;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.8rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .controls input[type="search"] {
    flex: 1 1 12rem;
    min-width: 8rem;
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    cursor: pointer;
  }
  .stats {
    margin-left: auto;
  }
  .stage {
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }
  .status {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0;
  }
  .status[role="alert"] {
    color: var(--danger);
  }
</style>
