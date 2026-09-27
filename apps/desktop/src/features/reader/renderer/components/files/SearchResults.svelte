<script lang="ts">
  /** 侧栏全文检索结果：命中列表、状态与键盘导航；查询执行由 ReaderSearch 负责。 */
  import type { SearchHit } from "../../../shared/api";
  import { SEARCH_LIMIT, snippetParts } from "../../engine/search/query";
  import type { ReaderSearch } from "../../state/search.svelte";

  let {
    search,
    activePath,
    onActivate,
    onExit,
  }: {
    /** 工作区持有的检索状态；结果只在最近一次成功检索后更新。 */
    search: ReaderSearch;
    /** 当前打开的文件路径，用于命中标记。 */
    activePath: string | null;
    /** 打开命中文件并定位命中词。 */
    onActivate: (hit: SearchHit) => void;
    /** 退出结果模式（Escape），焦点交回搜索框。 */
    onExit: () => void;
  } = $props();

  let listElement: HTMLElement | undefined = $state();
  let focusedIndex = $state(0);
  const hits = $derived(search.hits);
  const limit = $derived(search.query?.limit ?? SEARCH_LIMIT);
  const status = $derived(
    search.busy
      ? "正在搜索…"
      : search.error !== null
        ? search.error
        : hits.length >= limit
          ? `共 ${hits.length} 条结果，仅显示前 ${limit} 条`
          : `共 ${hits.length} 条结果`,
  );

  /** 提交检索后键盘从列表第一项继续。 */
  export function focusFirst(): void {
    focusedIndex = 0;
    listElement?.querySelector<HTMLButtonElement>("[data-index='0']")?.focus();
  }

  function keydown(event: KeyboardEvent, index: number): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onExit();
      return;
    }
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(index + 1, hits.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = hits.length - 1;
    else return;
    event.preventDefault();
    focusedIndex = next;
    listElement?.querySelector<HTMLButtonElement>(`[data-index='${next}']`)?.focus();
  }
</script>

<section class="results" aria-label="全文搜索结果" bind:this={listElement}>
  <div class="status" role="status">{status}</div>
  {#if search.busy}
    <!-- 在途检索期间隐藏旧结果，避免把上一个查询的命中当作当前查询的。 -->
  {:else if search.error === null && hits.length === 0}
    <div class="empty">
      <strong>没有匹配的笔记</strong>
      <p>换个关键词，或用 OR、-排除、tag:标签、path:路径、[属性:值]、line:( ) 调整范围。</p>
    </div>
  {:else if search.error === null}
    <ul>
      {#each hits as hit, index (hit.path)}
        <li>
          <button
            type="button"
            class="hit"
            class:active={hit.path === activePath}
            data-index={index}
            tabindex={focusedIndex === index ? 0 : -1}
            title={hit.path}
            onclick={() => onActivate(hit)}
            onfocus={() => (focusedIndex = index)}
            onkeydown={(event) => keydown(event, index)}
          >
            <span class="title">{hit.title}</span>
            <span class="path">{hit.path}</span>
            {#if hit.snippet !== ""}
              <span class="snippet">
                {#each snippetParts(hit.snippet) as part, partIndex (partIndex)}
                  {#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .results {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 0 0.55rem 0.65rem;
  }
  .status {
    color: var(--muted);
    font-size: 0.75rem;
    padding: 0 0.25rem 0.45rem;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .hit {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    width: 100%;
    padding: 0.45rem 0.5rem;
    margin-bottom: 0.15rem;
    border: 0;
    border-radius: 0.45rem;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .hit:hover {
    background: var(--selected);
  }
  .hit:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .hit.active {
    background: var(--selected);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .active .title {
    color: var(--accent);
  }
  .path {
    color: var(--muted);
    font-size: 0.7rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
  }
  .snippet {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.55;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  mark {
    color: var(--fg);
    background: transparent;
    font-weight: 600;
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
</style>
