<script lang="ts">
  /**
   * 递归画大纲树。三角折叠，标题文字才跳转。
   */
  import OutlineTree from "./OutlineTree.svelte";
  import { disclosure } from "../disclosure";
  import { finishOnReducedMotion } from "../transition-lifecycle";
  import type { OutlineNode } from "../../shared/markdown/outline";

  type Props = {
    activeKey?: string | null;
    nodes: OutlineNode[];
    collapsed: string[];
    onToggle: (key: string) => void;
    onJump: (pos: number) => void;
  };

  let { nodes, collapsed, onToggle, onJump, activeKey = null }: Props = $props();

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
        <span aria-hidden="true">▸</span>
      </button>
    {:else}
      <span class="twist-space"></span>
    {/if}
    <button
      type="button"
      class="label"
      aria-current={activeKey === node.key ? "location" : undefined}
      title={node.item.text}
      onclick={() => onJump(node.item.pos)}
    >
      {node.item.text}
    </button>
  </div>
  {#if node.children.length > 0 && !folded(node.key)}
    <div class="kids" transition:disclosure use:finishOnReducedMotion>
      <OutlineTree nodes={node.children} {activeKey} {collapsed} {onToggle} {onJump} />
    </div>
  {/if}
{/each}

<style>
  .label[aria-current="location"] {
    color: var(--accent);
    background: var(--selected);
    font-weight: 600;
  }
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

  .twist > span {
    display: inline-block;
  }
  .twist {
    display: inline-flex;
    align-self: stretch;
    align-items: center;
    justify-content: center;
    border-radius: 0.25rem;
    cursor: pointer;
  }
  .twist:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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
    border-radius: 0.25rem;
  }

  .label:hover,
  .label:focus-visible {
    color: var(--accent);
    background: color-mix(in srgb, var(--selected) 65%, transparent);
  }

  .kids {
    padding-left: 0.75rem;
  }
</style>
