<script lang="ts">
  /** 侧栏外壳：组件栏、目录与全文搜索；文件浏览已迁至独立的文件系统页。 */
  import SearchResults from "../search/SearchResults.svelte";
  import type { ReaderCommand } from "../../shared/commands";
  import type { SearchHit, SearchMatch } from "../../shared/api";
  import Sidebar from "../library/Sidebar.svelte";
  import ComponentBar from "./ComponentBar.svelte";
  import type { SidebarEntry, SidebarPanel } from "./sidebar-components";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { tick, type Snippet } from "svelte";
  import { createCompositionGuard } from "../../shared/composition";
  let {
    workspace,
    hidden,
    width,
    onWidth,
    onOpen,
    onCommand,
    canRun,
    onSearchHit,
    documentTools,
    footer,
    panel,
    activeEntry,
    onSelectPanel,
    libraryShown = false,
  }: {
    /** 当前文档的目录（大纲）；无标题时由文档栏回退展示最近文件。 */
    documentTools?: Snippet;
    footer?: Snippet;
    panel?: SidebarPanel;
    activeEntry?: SidebarEntry["id"];
    onSelectPanel?: (panel: SidebarPanel) => void;
    /** 文件系统页隐藏文档专属内容，全文搜索仍可独立使用。 */
    libraryShown?: boolean;
    canRun: (command: ReaderCommand) => boolean;
    onCommand: (command: ReaderCommand) => void;
    onSearchHit: (hit: SearchHit, match?: SearchMatch) => void;
    workspace: ReaderWorkspaceController;
    hidden: boolean;
    width: number;
    onWidth: (width: number) => void;
    /** 全文搜索的文件名命中直接打开；文件浏览与整理在文件系统页完成。 */
    onOpen: (path: string) => void;
  } = $props();
  const selected = $derived(panel ?? workspace.sidebarView);
  function selectComponent(entry: SidebarEntry): void {
    if (entry.kind === "command") onCommand(entry.id);
    else if (onSelectPanel) onSelectPanel(entry.id);
    else {
      workspace.setSidebarView(entry.id);
      if (entry.id === "search") void focusSearch();
    }
  }
  let fullSearchInput: HTMLInputElement;
  let searchResults: SearchResults | undefined = $state();
  const composition = createCompositionGuard();
  const active = $derived(workspace.document.path);
  const nameMatches = $derived(
    workspace.search.input.trim() === ""
      ? []
      : workspace.files.filter(
          (path) =>
            path.toLocaleLowerCase().includes(workspace.search.input.trim().toLocaleLowerCase()) &&
            !workspace.search.hits.some((hit) => hit.path === path),
        ),
  );
  /** 搜索入口聚焦现存输入框，保留查询和结果位置。 */
  export async function focusSearch(): Promise<void> {
    await tick();
    if (!hidden) fullSearchInput.focus();
  }
  function searchInputChanged(event: Event & { currentTarget: HTMLInputElement }): void {
    workspace.setSearchInput(
      event.currentTarget.value,
      composition.active || (event instanceof InputEvent && event.isComposing),
    );
  }
</script>

<Sidebar {width} {onWidth} {hidden} compact={libraryShown && selected !== "search"}>
  <ComponentBar
    compact={libraryShown && selected !== "search"}
    active={activeEntry ?? selected}
    disabled={workspace.isComposing}
    canRun={(entry) => entry.kind === "panel" || canRun(entry.id)}
    onSelect={selectComponent}
  />
  {#if documentTools}<div
      class="document-tools"
      data-motion="reveal"
      hidden={selected !== "outline" || libraryShown}
    >
      {@render documentTools()}
    </div>{/if}
  <nav
    class="quick-navigation"
    data-motion="reveal"
    aria-label="搜索"
    hidden={selected !== "search"}
    use:composition.bind
  >
    <div class="search-content">
      <input
        class="reader-input"
        type="text"
        role="searchbox"
        aria-label="搜索文件和全文"
        placeholder="搜索文件名与正文…"
        bind:this={fullSearchInput}
        value={workspace.search.input}
        oninput={searchInputChanged}
        oncompositionend={(event) => workspace.setSearchInput(event.currentTarget.value)}
        onkeydown={(event) => {
          if (composition.active) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void workspace.search.run(workspace.search.input);
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            searchResults?.focusFirst();
          }
          if (event.key === "Escape") {
            event.stopPropagation();
            fullSearchInput.focus();
          }
        }}
      />
      {#if workspace.search.input !== ""}<button
          class="reader-button clear-full-search"
          type="button"
          aria-label="清除搜索"
          onclick={() => {
            workspace.setSearchInput("");
            fullSearchInput.focus();
          }}>清除搜索</button
        >{/if}
      {#if workspace.search.input.trim() !== "" || workspace.search.active}
        {#if nameMatches.length > 0}<div class="filename-matches" aria-label="文件名匹配">
            {#each nameMatches as path (path)}<button
                class="reader-button"
                type="button"
                onclick={() => onOpen(path)}
                title={path}>{path}</button
              >{/each}
          </div>{/if}
        <SearchResults
          bind:this={searchResults}
          search={workspace.search}
          activePath={active}
          onActivate={onSearchHit}
          onExit={() => fullSearchInput.focus()}
          onFocusSearch={() => fullSearchInput.focus()}
        />
      {:else}<p class="empty">输入关键词，搜索当前笔记库的文件名和正文。</p>{/if}
    </div>
  </nav>
  {@render footer?.()}
</Sidebar>

<style>
  .search-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .filename-matches {
    max-height: 30%;
    overflow: auto;
  }
  .filename-matches button {
    display: block;
    text-align: left;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quick-navigation {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    padding: 0 0.75rem 0.75rem;
    background: var(--sidebar);
  }
  .document-tools {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    border-bottom: 1px solid var(--border);
  }
  .document-tools[hidden],
  .quick-navigation[hidden] {
    display: none;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.65rem 0.5rem;
    font-size: 0.8rem;
    line-height: 1.6;
    color: var(--muted);
  }
</style>
