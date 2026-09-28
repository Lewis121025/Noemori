<script lang="ts">
  /**
   * 正文末尾的局部图谱：与出链、反链并列，默认收起。
   * 展开后才读取索引与布局；在同一栏里切换笔记时保持展开状态与节点坐标。
   */
  import type { GraphNode } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import GraphPanel from "./GraphPanel.svelte";

  let {
    workspace,
    path,
    onOpen,
  }: {
    workspace: ReaderWorkspaceController;
    /** 当前笔记；作为局部图谱的中心。 */
    path: string;
    onOpen: (node: GraphNode) => void;
  } = $props();

  let open = $state(false);
</script>

<section class="local-graph" aria-label="局部关系图谱">
  <details bind:open>
    <summary>局部图谱</summary>
    {#if open}
      <div class="body">
        <GraphPanel {workspace} center={path} {onOpen} />
      </div>
    {/if}
  </details>
</section>

<style>
  .local-graph {
    margin-top: 1.5rem;
    padding: 1rem 0 0.5rem;
    border-top: 1px solid var(--border);
    font-size: 0.875rem;
  }
  summary {
    color: var(--muted);
    cursor: pointer;
    padding: 0.25rem 0;
    width: fit-content;
  }
  summary:hover,
  details[open] > summary {
    color: var(--fg);
  }
  .body {
    padding-top: 0.5rem;
  }
</style>
