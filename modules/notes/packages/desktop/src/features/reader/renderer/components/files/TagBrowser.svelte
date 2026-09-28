<script lang="ts">
  /**
   * 侧栏标签浏览：嵌套标签按 `/` 组树，计数向祖先汇总。
   * 点击标签以 `tag:` 谓词进入检索结果；清单在每次进入面板时重新拉取。
   */
  import { onMount } from "svelte";
  import type { ReaderWorkspaceController } from "../../state/workspace.svelte";
  import { buildTagTree, visibleTagRows, type TagNode } from "../../engine/navigation/tag-tree";

  let {
    workspace,
    onPick,
  }: {
    workspace: ReaderWorkspaceController;
    /** 选中标签，由文件栏转成 `tag:` 检索。 */
    onPick: (tag: string) => void;
  } = $props();

  let nodes = $state<TagNode[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let expanded = $state<ReadonlySet<string>>(new Set());
  const rows = $derived(visibleTagRows(nodes, expanded));

  onMount(() => {
    void (async () => {
      const result = await workspace.listTags();
      error = result.error;
      nodes = buildTagTree(result.tags);
      // 默认展开顶层，深层按需展开。
      expanded = new Set(nodes.map((node) => node.path));
      loading = false;
    })();
  });

  function toggle(path: string): void {
    expanded = expanded.has(path)
      ? new Set([...expanded].filter((item) => item !== path))
      : new Set([...expanded, path]);
  }
</script>

<div class="tags">
  {#if loading}
    <p class="status">正在读取标签…</p>
  {:else if error !== null}
    <p class="status" role="alert">{error}</p>
  {:else if rows.length === 0}
    <div class="empty">
      <strong>还没有标签</strong>
      <p>在笔记里写 #标签，或在 frontmatter 的 tags 里声明。</p>
    </div>
  {:else}
    <ul role="tree" aria-label="标签清单">
      {#each rows as { node, depth } (node.path)}
        <li
          role="treeitem"
          aria-selected="false"
          aria-expanded={node.children.length > 0 ? expanded.has(node.path) : undefined}
          aria-level={depth + 1}
        >
          <span class="row" style:--depth={depth}>
            <button
              type="button"
              class="chevron"
              tabindex={-1}
              aria-hidden={node.children.length === 0}
              class:expanded={expanded.has(node.path)}
              onclick={() => toggle(node.path)}
              >{#if node.children.length > 0}<svg viewBox="0 0 16 16" aria-hidden="true"
                  ><path d="m6 4 4 4-4 4" /></svg
                >{/if}</button
            >
            <button type="button" class="tag" onclick={() => onPick(node.path)}>
              <span class="name">#{node.name}</span>
              <span class="count">{node.count}</span>
            </button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tags {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 0 0.55rem 0.65rem;
  }
  .status {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 0.5rem 0.25rem;
    margin: 0;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    padding-left: calc(var(--depth) * 0.9rem);
  }
  .chevron {
    flex: 0 0 1.1rem;
    height: 1.4rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--muted);
    padding: 0;
    cursor: pointer;
    border-radius: 0.3rem;
  }
  .chevron svg {
    width: 0.7rem;
    height: 0.7rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.12s;
  }
  .chevron.expanded svg {
    transform: rotate(90deg);
  }
  .tag {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.4rem;
    padding: 0.3rem 0.5rem;
    border: 0;
    border-radius: 0.4rem;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.83rem;
    text-align: left;
    cursor: pointer;
  }
  .tag:hover {
    background: var(--selected);
  }
  .tag:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--accent);
  }
  .count {
    flex-shrink: 0;
    color: var(--muted);
    font-size: 0.7rem;
  }
  .empty {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 2rem 0.8rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    text-align: center;
  }
  .empty strong {
    font-weight: 500;
    color: var(--fg);
  }
  .empty p {
    margin: 0;
    max-width: 13rem;
    line-height: 1.6;
  }
  @media (prefers-reduced-motion: reduce) {
    .chevron svg {
      transition: none;
    }
  }
</style>
