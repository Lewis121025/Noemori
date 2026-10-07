<script lang="ts">
  /** 独立资料管理页面：选择与文件操作由工作区持有，预览不切换正在编辑的文档。 */
  import { onMount, type Snippet } from "svelte";
  import type { VaultEntry } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import type { FileMenuAction } from "./FileMenu.svelte";
  import { isCompositionKey } from "../../shared/composition";
  import LibraryPreview from "./LibraryPreview.svelte";

  let {
    workspace,
    hidden,
    selected,
    onAction,
    onOpen,
    readFile,
    children,
    previewOpen = $bindable(false),
    onClosePreview,
    onNewWhiteboard,
    count,
  }: {
    workspace: ReaderWorkspaceController;
    hidden: boolean;
    selected: VaultEntry[];
    onAction: (action: FileMenuAction, entry: VaultEntry | null) => void;
    onOpen: (entry: VaultEntry) => void;
    readFile: (path: string) => Promise<Uint8Array>;
    children: Snippet;
    previewOpen?: boolean;
    onClosePreview: () => void;
    onNewWhiteboard?: () => void;
    count: number;
  } = $props();
  let compact = $state(false);
  let container: HTMLElement;
  const current = $derived(selected.length === 1 ? selected[0]! : null);
  const busy = $derived(workspace.switching || workspace.copying);

  function resize(): void {
    compact = window.innerWidth <= 720;
    if (!compact) previewOpen = false;
  }
  onMount(resize);

  function previewKeydown(event: KeyboardEvent): void {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      isCompositionKey(event) ||
      workspace.isComposing ||
      hidden ||
      !compact ||
      !previewOpen ||
      !(event.target instanceof Element) ||
      !container.contains(event.target) ||
      event.target.closest("dialog[open], [popover]")
    )
      return;
    event.preventDefault();
    onClosePreview();
  }
</script>

<svelte:window onresize={resize} onkeydown={previewKeydown} />

<section class="library" data-motion="reveal" {hidden} aria-label="文件系统" bind:this={container}>
  <header class="library-heading">
    <div>
      <h1>文件系统</h1>
      <p>
        {count} 个文件和文件夹
      </p>
    </div>
    <div class="create-actions">
      {#if onNewWhiteboard}<button
          class="reader-button"
          type="button"
          disabled={busy}
          onclick={onNewWhiteboard}>新建白板</button
        >{/if}
      <button
        class="reader-button"
        type="button"
        aria-label="新建文件夹"
        title="新建文件夹"
        disabled={busy || workspace.vaultRoot === null}
        onclick={() => onAction("directory", current)}
        ><svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M3 7V5h7l2 2h9v13H3V7M12 10v7m-3-3.5h6" /></svg
        ></button
      >
      <button
        class="reader-button primary"
        type="button"
        disabled={busy}
        onclick={() => onAction("file", current)}>新建笔记</button
      >
    </div>
  </header>
  <div class="library-actions" role="toolbar" aria-label="资料整理">
    <span>{selected.length > 0 ? `已选 ${selected.length} 项` : "浏览资料"}</span>
    {#if compact}
      <button
        class="reader-button"
        type="button"
        aria-expanded={previewOpen}
        disabled={!previewOpen && current === null}
        onclick={() => {
          if (previewOpen) onClosePreview();
          else previewOpen = true;
        }}>{previewOpen ? "返回列表" : "预览"}</button
      >
    {/if}
    {#if selected.length > 0}
      <button
        class="reader-button"
        type="button"
        disabled={busy}
        onclick={() => onAction("export", current)}>导出…</button
      >
      <button
        class="reader-button"
        type="button"
        aria-label="重命名"
        title="重命名"
        disabled={busy || current === null}
        onclick={() => onAction("rename", current)}
        ><svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="m4 16 11-11 4 4-11 11H4v-4M13 7l4 4M14 20h6" /></svg
        ></button
      >
      <button
        class="reader-button"
        type="button"
        aria-label="移动到…"
        title="移动到…"
        disabled={busy}
        onclick={() => onAction("move", current)}
        ><svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M3 7V5h7l2 2h9v13H3V7m5 7h9m-3-3 3 3-3 3" /></svg
        ></button
      >
      <button
        class="reader-button"
        type="button"
        aria-label="移到废纸篓"
        title="移到废纸篓"
        disabled={busy}
        onclick={() => onAction("trash", current)}
        ><svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13m-8 4v5m4-5v5" /></svg
        ></button
      >
    {/if}
  </div>
  <div class="library-body">
    <div class="library-list" inert={compact && previewOpen} aria-hidden={compact && previewOpen}>
      {@render children()}
    </div>
    {#if !hidden && (!compact || previewOpen)}<LibraryPreview
        entry={current}
        entries={workspace.entries}
        root={workspace.vaultRoot}
        revision={workspace.indexRevision}
        {readFile}
        {onOpen}
        {busy}
        selectionCount={selected.length}
      />{/if}
  </div>
</section>

<style>
  .library[hidden] {
    display: none;
  }
  .library {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .library-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.75rem 2.5rem 0.75rem;
  }
  h1 {
    font-size: 1.6rem;
    letter-spacing: -0.04em;
    font-weight: 500;
    margin: 0;
  }
  p {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0.25rem 0 0;
  }
  .create-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .create-actions .reader-button,
  .library-actions .reader-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .library-actions .reader-button {
    background: transparent;
    border-color: transparent;
    color: var(--muted);
  }
  .library-actions .reader-button:hover:not(:disabled) {
    background: var(--selected);
    color: var(--fg);
  }
  .library-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.5rem 2.5rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .library-actions span {
    flex: 1;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .library-body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 34%);
    margin: 0 2.5rem 2rem;
    padding-top: 1rem;
  }
  .library-list {
    min-height: 0;
    min-width: 0;
  }
  .library-list[inert] {
    position: absolute;
    inset: 0;
    visibility: hidden;
  }
  @media (max-width: 720px) {
    .library-heading {
      padding: 1rem;
    }
    .library-actions {
      padding: 0.5rem 1rem;
      flex-wrap: wrap;
    }
    .library-body {
      margin: 0 1rem 1rem;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
    }
  }
</style>
