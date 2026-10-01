<script lang="ts">
  /** 关联页面只组织视图；白板继续使用工作区的文档、保存与撤销生命周期。 */
  import { tick } from "svelte";
  import type { GraphNode } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import type { ConnectionView } from "../workspace/spaces.svelte";
  import { isWhiteboardPath } from "../whiteboard/model";
  import GraphPanel from "./GraphPanel.svelte";

  let {
    workspace,
    view,
    busy,
    onView,
    onOpen,
    onGraphNode,
    onNew,
  }: {
    workspace: ReaderWorkspaceController;
    view: ConnectionView;
    busy: boolean;
    onView: (view: Exclude<ConnectionView, "canvas">) => void;
    onOpen: (path: string) => void;
    onGraphNode: (node: GraphNode) => void;
    onNew: () => void;
  } = $props();

  const boards = $derived(workspace.files.filter(isWhiteboardPath));
  let graphElement: HTMLDivElement | undefined = $state();
  const title = $derived(view === "canvas" ? boardTitle(workspace.document.path) : "关联");

  function boardTitle(path: string | null): string {
    return path === null
      ? "白板"
      : path.slice(path.lastIndexOf("/") + 1).replace(/\.noemoriboard$/iu, "");
  }

  $effect(() => {
    if (view !== "graph") return;
    let cancelled = false;
    void tick().then(() => {
      if (!cancelled && graphElement?.isConnected)
        graphElement.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    });
    return () => {
      cancelled = true;
    };
  });
</script>

<section class="connections" class:canvas={view === "canvas"} aria-label="关联空间">
  <header>
    <div class="heading">
      {#if view === "canvas"}
        <button
          class="reader-button back"
          type="button"
          aria-label="返回白板列表"
          title="全部白板"
          disabled={busy}
          onclick={() => onView("boards")}
        >
          <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
            ><path d="m14 6-6 6 6 6" /></svg
          >
        </button>
      {/if}
      <h1 {title}>{title}</h1>
      {#if view === "boards"}<span class="count">{boards.length} 个白板</span>{/if}
    </div>
    <div class="view-switch" role="group" aria-label="关联视图">
      <button
        type="button"
        aria-pressed={view !== "graph"}
        disabled={busy}
        onclick={() => onView("boards")}>白板</button
      >
      <button
        type="button"
        aria-pressed={view === "graph"}
        disabled={busy}
        onclick={() => onView("graph")}>图谱</button
      >
    </div>
  </header>
  {#if view === "graph"}
    <div class="graph" bind:this={graphElement}>
      <GraphPanel {workspace} center={null} onOpen={onGraphNode} />
    </div>
  {:else if view === "boards"}
    <div class="board-list">
      {#each boards as path (path)}
        <button
          class="board"
          type="button"
          disabled={busy}
          title={path}
          onclick={() => onOpen(path)}
        >
          <div class="board-cover" aria-hidden="true">
            <svg viewBox="0 0 100 64"
              ><rect x="16" y="12" width="28" height="21" rx="4" /><path
                d="M44 22h8q7 0 7 7v9h8"
              /><rect x="60" y="32" width="25" height="20" rx="4" /></svg
            >
          </div>
          <strong>{boardTitle(path)}</strong>
          <span>{path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "白板"}</span>
        </button>
      {:else}
        <div class="empty">
          <svg viewBox="0 0 64 64" aria-hidden="true"
            ><rect x="9" y="12" width="24" height="19" rx="5" /><path d="M33 22h5q7 0 7 7v7" /><rect
              x="33"
              y="35"
              width="23"
              height="18"
              rx="5"
            /></svg
          >
          <h2>让想法连在一起</h2>
          <p>一块白板，展开新的思路。</p>
          <button class="reader-button primary" type="button" disabled={busy} onclick={onNew}
            >创建白板</button
          >
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .connections {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .connections.canvas {
    flex: 0 0 auto;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 2rem 2.5rem 1.5rem;
  }
  .canvas header {
    padding: 0.7rem 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  .heading {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    min-width: 0;
  }
  h1 {
    font-size: 1.6rem;
    font-weight: 550;
    letter-spacing: -0.04em;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .canvas h1 {
    font-size: 0.9rem;
    letter-spacing: 0;
  }
  .count {
    color: var(--muted);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .back {
    display: flex;
    padding: 0.25rem;
    background: transparent;
    border-color: transparent;
  }
  .view-switch {
    display: flex;
    padding: 3px;
    border-radius: 9px;
    background: var(--sidebar);
    flex-shrink: 0;
  }
  .view-switch button {
    color: var(--muted);
    background: transparent;
    border: 0;
    border-radius: 6px;
    padding: 0.35rem 1rem;
    cursor: pointer;
  }
  .view-switch button[aria-pressed="true"] {
    color: var(--fg);
    background: var(--surface);
    box-shadow: 0 1px 4px var(--shadow);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .graph {
    flex: 1;
    min-height: 0;
    padding: 0 2.5rem 2rem;
  }
  .board-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    align-content: start;
    gap: 1.5rem;
    padding: 0.5rem 2.5rem 2rem;
    overflow: auto;
    flex: 1;
  }
  .board {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 0 0 1rem;
    background: var(--surface);
    color: var(--fg);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    box-shadow: 0 2px 4px var(--shadow);
    transition:
      border-color var(--motion-fast),
      box-shadow var(--motion-fast);
  }
  .board:hover:not(:disabled) {
    border-color: var(--accent);
    box-shadow: 0 6px 20px var(--shadow);
  }
  .board-cover {
    display: grid;
    place-items: center;
    height: 150px;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border);
    background-color: var(--sidebar);
    background-image: radial-gradient(var(--border) 0.8px, transparent 0.8px);
    background-size: 16px 16px;
  }
  .board-cover svg {
    width: 110px;
    fill: var(--surface);
    stroke: var(--muted);
    stroke-width: 1;
  }
  .board strong,
  .board span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 1rem;
  }
  .board strong {
    font-size: 0.95rem;
    font-weight: 500;
  }
  .board span {
    color: var(--muted);
    font-size: 0.75rem;
    margin-top: 0.2rem;
  }
  .empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 12vh 1rem;
  }
  .empty svg {
    width: 64px;
    height: 64px;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.2;
  }
  h2 {
    font-size: 1.35rem;
    font-weight: 500;
    margin: 1rem 0 0.5rem;
  }
  .empty p {
    color: var(--muted);
    margin: 0 0 1.5rem;
  }
  @media (max-width: 640px) {
    header {
      padding: 1.4rem 1rem;
    }
    .graph {
      padding: 0 1rem 1rem;
    }
    .board-list {
      padding: 0 1rem 1rem;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 1rem;
    }
    .count {
      display: none;
    }
  }
</style>
