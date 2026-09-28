<script lang="ts">
  /**
   * 递归画大纲树。三角折叠，标题文字才跳转。
   */
  import OutlineTree from "./OutlineTree.svelte";
  import type { OutlineNode } from "../../engine/navigation/outline";

  type Props = {
    nodes: OutlineNode[];
    collapsed: string[];
    onToggle: (key: string) => void;
    onJump: (pos: number) => void;
  };

  let { nodes, collapsed, onToggle, onJump }: Props = $props();

  function folded(key: string): boolean {
    return collapsed.includes(key);
  }
</script>

{#each nodes as node (node.key)}
  <div class="row">
    {#if node.children.length > 0}
      <button
        type="button"
        class="twist"
        aria-expanded={folded(node.key) ? "false" : "true"}
        aria-label={folded(node.key) ? "展开" : "折叠"}
        onclick={() => onToggle(node.key)}
      >
        {folded(node.key) ? "▸" : "▾"}
      </button>
    {:else}
      <span class="twist-space"></span>
    {/if}
    <button type="button" class="label" onclick={() => onJump(node.item.pos)}>
      {node.item.text}
    </button>
  </div>
  {#if node.children.length > 0 && !folded(node.key)}
    <div class="kids">
      <OutlineTree nodes={node.children} {collapsed} {onToggle} {onJump} />
    </div>
  {/if}
{/each}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.1rem;
    min-width: 0;
  }

  .twist,
  .twist-space {
    flex: 0 0 1.1rem;
    width: 1.1rem;
    border: none;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    line-height: 1;
  }

  .twist {
    cursor: pointer;
  }

  .label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0.15rem 0.2rem;
  }

  .kids {
    padding-left: 0.75rem;
  }
</style>
