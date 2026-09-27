<script lang="ts">
  /** 侧栏全文检索结果：命中列表、状态与键盘导航；查询执行由 ReaderSearch 负责。 */
  import type { SearchHit, SearchMatch } from "../../../shared/api";
  import { tick } from "svelte";
  import { snippetParts } from "../../engine/search/query";
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
    /** 打开用户选择的具体命中；省略时进入文件第一处命中。 */
    onActivate: (hit: SearchHit, match?: SearchMatch) => void;
    /** 退出结果模式（Escape），焦点交回搜索框。 */
    onExit: () => void;
  } = $props();

  let listElement: HTMLElement | undefined = $state();
  let focusedIndex = $state(0);
  let expanded = $state<Record<string, boolean>>({});
  const hits = $derived(search.hits);
  const matchCount = $derived(hits.reduce((total, hit) => total + hit.matchCount, 0));
  const status = $derived(
    search.busy
      ? "正在搜索…"
      : search.error !== null
        ? search.error
        : search.hasMore
          ? `已显示 ${hits.length} 篇 · ${matchCount} 处命中${search.loadingMore ? " · 正在加载…" : ""}`
          : `共 ${hits.length} 篇 · ${matchCount} 处命中`,
  );

  /** 提交检索后键盘从列表第一项继续。 */
  export function focusFirst(): void {
    focusedIndex = 0;
    listElement?.querySelector<HTMLButtonElement>("[data-index='0']")?.focus();
  }

  async function loadMore(event: MouseEvent & { currentTarget: HTMLButtonElement }): Promise<void> {
    const button = event.currentTarget;
    const ownedFocus = document.activeElement === button;
    const query = search.query;
    const firstNew = hits.length;
    await search.loadMore();
    await tick();
    // 仅延续发起按钮的焦点；加载期间用户已回到旧命中或编辑器时不抢回。
    if (
      search.query === query &&
      hits.length > firstNew &&
      ownedFocus &&
      (document.activeElement === button || document.activeElement === document.body)
    ) {
      listElement?.querySelector<HTMLButtonElement>(`[data-index='${firstNew}']`)?.focus();
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onExit();
      return;
    }
    const buttons = Array.from(listElement?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.findIndex((button) => button === event.currentTarget);
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(index + 1, buttons.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  async function loadMatches(
    hit: SearchHit,
    event: MouseEvent & { currentTarget: HTMLButtonElement },
  ): Promise<void> {
    const button = event.currentTarget;
    const ownedFocus = document.activeElement === button;
    const group = button.closest("[data-search-result]");
    const query = search.query;
    const firstNew = hit.matches.length;
    const published = await search.loadMatches(hit.path);
    await tick();
    if (
      published &&
      search.query === query &&
      expanded[hit.path] &&
      ownedFocus &&
      (document.activeElement === button || document.activeElement === document.body)
    )
      group?.querySelector<HTMLButtonElement>(`[data-occurrence='${firstNew}']`)?.focus();
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
  {:else if hits.length > 0}
    <ul>
      {#each hits as hit, index (hit.path)}
        <li data-search-result>
          <button
            type="button"
            class="hit"
            class:active={hit.path === activePath}
            data-index={index}
            tabindex={focusedIndex === index ? 0 : -1}
            title={hit.path}
            onclick={() => onActivate(hit)}
            onfocus={() => (focusedIndex = index)}
            onkeydown={keydown}
          >
            <span class="title">{hit.title}</span>
            <span class="path">{hit.path}</span>
            {#if hit.snippet !== "" && !expanded[hit.path]}
              <span class="snippet">
                {#each snippetParts(hit.snippet) as part, partIndex (partIndex)}
                  {#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
            {/if}
          </button>
          {#if hit.matchCount > 0}
            <button
              class="expand"
              aria-label={`${expanded[hit.path] ? "收起" : "展开"} ${hit.title} 的 ${hit.matchCount} 处命中`}
              aria-expanded={expanded[hit.path] ?? false}
              onclick={() => (expanded[hit.path] = !expanded[hit.path])}
              onkeydown={keydown}
            >
              <span aria-hidden="true">{expanded[hit.path] ? "⌄" : "›"}</span>
              {hit.matchCount} 处命中
            </button>
            {#if expanded[hit.path]}
              <ol class="occurrences">
                {#each hit.matches as match, matchIndex (matchIndex)}
                  <li>
                    <button
                      class="occurrence"
                      data-occurrence={matchIndex}
                      onclick={() => onActivate(hit, match)}
                      onkeydown={keydown}
                    >
                      <span class="line"
                        >{match.location === null ? "上下文" : `第 ${match.location.line} 行`}</span
                      >
                      <span class="snippet">
                        {#each snippetParts(match.snippet) as part, partIndex (partIndex)}
                          {#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}
                        {/each}
                      </span>
                    </button>
                  </li>
                {/each}
              </ol>
              {#if search.matchError(hit.path) !== null}
                <p class="match-error" role="alert">{search.matchError(hit.path)}</p>
                <button class="expand" onclick={() => void search.refresh()} onkeydown={keydown}
                  >重新搜索</button
                >
              {:else if hit.matchesCursor !== null}
                <button
                  class="expand"
                  aria-disabled={search.loadingMatches(hit.path)}
                  onclick={(event) => loadMatches(hit, event)}
                  onkeydown={keydown}
                >
                  {search.loadingMatches(hit.path)
                    ? "正在加载命中…"
                    : `显示更多 · 还有 ${hit.matchCount - hit.matches.length} 处`}
                </button>
              {/if}
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if !search.busy && search.error !== null}
    <button class="expand" onclick={() => void search.refresh()} onkeydown={keydown}
      >重新搜索</button
    >
  {:else if search.hasMore}
    <button class="expand" aria-disabled={search.loadingMore} onclick={loadMore} onkeydown={keydown}
      >{search.loadingMore ? "正在加载…" : "加载更多结果"}</button
    >
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
  .match-error {
    color: var(--muted);
    font-size: 0.75rem;
    padding: 0 0.5rem;
  }
  ul,
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .hit,
  .occurrence {
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
  .hit:hover,
  .occurrence:hover,
  .expand:hover {
    background: var(--selected);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .hit.active {
    background: var(--selected);
  }
  .expand {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border: 0;
    border-radius: 0.3rem;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.7rem;
    padding: 0.3rem 0.5rem;
    margin: 0 0 0.35rem;
    cursor: pointer;
  }
  .occurrences {
    margin: 0 0 0.4rem 0.65rem;
    border-left: 1px solid var(--border);
  }
  .line {
    color: var(--muted);
    font-size: 0.65rem;
    font-variant-numeric: tabular-nums;
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
