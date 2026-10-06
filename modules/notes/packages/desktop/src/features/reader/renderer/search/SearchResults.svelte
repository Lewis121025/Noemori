<script lang="ts">
  /** 侧栏全文检索结果：命中列表、状态与键盘导航；查询执行由 ReaderSearch 负责。 */
  import type { SearchHit, SearchMatch } from "../../shared/api";
  import { tick, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { snippetParts } from "./query";
  import type { ReaderSearch } from "./state.svelte";

  let {
    search,
    activePath,
    onActivate,
    onExit,
    onFocusSearch,
  }: {
    /** 工作区持有的检索状态；结果只在最近一次成功检索后更新。 */
    search: ReaderSearch;
    /** 当前打开的文件路径，用于命中标记。 */
    activePath: string | null;
    /** 打开用户选择的具体命中；省略时进入文件第一处命中。 */
    onActivate: (hit: SearchHit, match?: SearchMatch) => void;
    /** 退出结果模式（Escape），焦点交回搜索框。 */
    onExit: () => void;
    /** 刷新后结果清空时回到查询框；保留查询，不触发退出或重新提交。 */
    onFocusSearch: () => void;
  } = $props();

  let listElement: HTMLElement | undefined = $state();
  let focusedPath = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});
  const hits = $derived(search.hits);
  const tabPath = $derived(
    hits.some((hit) => hit.path === focusedPath) ? focusedPath : (hits[0]?.path ?? null),
  );
  const matchCount = $derived(hits.reduce((total, hit) => total + hit.matchCount, 0));
  const status = $derived(
    search.error !== null
      ? `${search.error}${search.stale ? "；当前显示的是上次结果。" : ""}`
      : search.stale
        ? "笔记库已变化，正在更新搜索结果…"
        : search.busy
          ? "正在搜索…"
          : search.semantic !== null
            ? `${search.hasMore ? "已显示 " : ""}${hits.length} 篇相关笔记${search.limited ? " · 可缩小范围继续查找" : ""}${search.loadingMore ? " · 正在加载…" : ""}`
            : search.hasMore
              ? `已显示 ${hits.length} 篇 · ${matchCount} 处命中${search.loadingMore ? " · 正在加载…" : ""}`
              : `共 ${hits.length} 篇 · ${matchCount} 处命中`,
  );

  $effect.pre(() => {
    const revision = search.revision;
    untrack(() => {
      const list = listElement;
      const active = document.activeElement;
      if (!list || !(active instanceof HTMLButtonElement) || !list.contains(active)) return;
      const identity = { ...active.dataset };
      const previous = Array.from(list.querySelectorAll<HTMLButtonElement>(".hit"));
      const paths = previous.map((button) => button.dataset.path);
      const index = identity.path === undefined ? paths.length : paths.indexOf(identity.path);
      void tick().then(() => {
        if (
          search.revision !== revision ||
          !list.isConnected ||
          list.closest("[hidden], [inert]") ||
          (document.activeElement !== active && document.activeElement !== document.body)
        )
          return;
        const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>("[data-search-focus]"));
        const exact = buttons.find((button) =>
          ["searchFocus", "path", "version", "occurrence"].every(
            (key) => button.dataset[key] === identity[key],
          ),
        );
        const files = buttons.filter((button) => button.dataset.searchFocus === "hit");
        const byPath = new SvelteMap(files.map((button) => [button.dataset.path, button]));
        // 原目标不在新快照中时，优先所属文件，再找原顺序中的后继、前驱，最后用新首项。
        const neighbors = [
          identity.path,
          ...paths.slice(index + 1),
          ...paths.slice(0, index).reverse(),
        ];
        const fallback = byPath.get(neighbors.find((path) => byPath.has(path))) ?? files[0];
        const next = exact ?? fallback;
        if (next) next.focus({ preventScroll: true });
        else onFocusSearch();
      });
    });
  });

  /** 提交检索后键盘从列表第一项继续。 */
  export function focusFirst(): void {
    focusedPath = hits[0]?.path ?? null;
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

<section
  class="results"
  aria-label="全文搜索结果"
  bind:this={listElement}
  onfocusin={(event) => {
    if (event.target instanceof HTMLButtonElement && event.target.dataset.path !== undefined)
      focusedPath = event.target.dataset.path;
  }}
>
  <div class="status" role="status">{status}</div>
  {#if search.semantic !== null && search.semantic.state !== "ready"}
    <div class="semantic-status" role="status">
      {#if search.modelInstalling}
        <span>正在下载或导入本地语义模型…</span>
        <button onclick={() => search.cancelModel()}>取消</button>
      {:else if search.semantic.state === "missing"}
        <span>已启用关键词和拼写容错。安装本地模型后可按意思查找。</span>
        <button onclick={() => search.installModel("download")}>下载语义模型（约 1.1 GB）</button>
        <button onclick={() => search.installModel("import")}>导入模型</button>
      {:else if search.semantic.state === "error"}
        <span>语义搜索暂不可用：{search.semantic.message}</span>
        <button onclick={() => search.installModel("download")}>重试</button>
        <button onclick={() => search.installModel("import")}>导入模型</button>
      {:else}
        <span
          >语义索引准备中：{search.semantic.indexed} / {search.semantic.total} 篇。当前结果可能不完整。</span
        >
        <button onclick={() => search.refresh()}>刷新</button>
      {/if}
    </div>
  {/if}
  {#if search.busy && hits.length === 0}
    <!-- 新查询不显示旧内容；同一查询的后台刷新保留已显示的节点和焦点。 -->
  {:else if !search.stale && search.error === null && hits.length === 0}
    <div class="empty">
      <strong>没有匹配的笔记</strong>
      <p>试试记得的其他词，或按标题、标签查找。</p>
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
            data-search-focus="hit"
            data-path={hit.path}
            tabindex={tabPath === hit.path ? 0 : -1}
            title={hit.path}
            onclick={() =>
              onActivate(
                hit,
                hit.matches[0] ?? hit.evidence?.find((item) => item.location !== null),
              )}
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
          {#each hit.evidence ?? [] as evidence (evidence.kind)}
            {#if evidence.kind !== "lexical"}
              <button
                class="semantic-evidence"
                data-search-focus="evidence"
                data-path={hit.path}
                data-version={hit.contentHash}
                data-occurrence={evidence.kind}
                onclick={() => onActivate(hit, evidence)}
                onkeydown={keydown}
              >
                <span>{evidence.kind === "semantic" ? "相关段落" : "拼写近似"}</span>
                {#each snippetParts(evidence.snippet) as part, partIndex (partIndex)}
                  {#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </button>
            {/if}
          {/each}
          {#if hit.matchCount > 0}
            <button
              class="expand"
              data-search-focus="expand"
              data-path={hit.path}
              aria-label={`${expanded[hit.path] ? "收起" : "展开"} ${hit.title} 的 ${hit.matchCount} 处命中`}
              aria-expanded={expanded[hit.path] ?? false}
              onclick={() => (expanded[hit.path] = !expanded[hit.path])}
              onkeydown={keydown}
            >
              <span aria-hidden="true">›</span>
              {hit.matchCount} 处命中
            </button>
            {#if expanded[hit.path]}
              <ol class="occurrences">
                {#each hit.matches as match, matchIndex (matchIndex)}
                  <li>
                    <button
                      class="occurrence"
                      data-occurrence={matchIndex}
                      data-search-focus="match"
                      data-path={hit.path}
                      data-version={hit.contentHash}
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
              {/if}
              {#if hit.matchesCursor !== null}
                <button
                  class="expand"
                  data-search-focus="more-matches"
                  data-path={hit.path}
                  aria-disabled={search.stale || search.busy || search.loadingMatches(hit.path)}
                  onclick={(event) => {
                    if (search.stale || search.busy) return;
                    if (search.matchError(hit.path) !== null) void search.refresh();
                    else void loadMatches(hit, event);
                  }}
                  onkeydown={keydown}
                >
                  {search.matchError(hit.path) !== null
                    ? "重新搜索"
                    : search.loadingMatches(hit.path)
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
  {#if search.error !== null || search.hasMore}
    <button
      class="expand"
      data-search-focus="more"
      aria-disabled={search.busy || search.loadingMore || (search.stale && search.error === null)}
      onclick={(event) => {
        if (search.busy || search.loadingMore) return;
        if (search.error !== null) void search.refresh();
        else void loadMore(event);
      }}
      onkeydown={keydown}
      >{search.error !== null
        ? "重新搜索"
        : search.loadingMore
          ? "正在加载…"
          : "加载更多结果"}</button
    >
  {/if}
</section>

<style>
  .semantic-status {
    display: grid;
    gap: 6px;
    padding: 8px 12px;
    font-size: 12px;
  }
  .semantic-evidence {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 12px;
    white-space: normal;
  }
  .semantic-evidence > span {
    display: block;
    opacity: 0.65;
    font-size: 11px;
  }

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
