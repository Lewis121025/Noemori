<script lang="ts">
  /** 独立资料管理页面：选择与文件操作由工作区持有，预览不切换正在编辑的文档。 */
  import { onMount, type Snippet } from "svelte";
  import type { VaultEntry } from "../../../shared/api";
  import type { ReaderWorkspaceController } from "../../state/workspace.svelte";
  import type { FileMenuAction } from "./FileMenu.svelte";
  import { isCompositionKey } from "../../engine/editing/composition";
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
  } = $props();
  let compact = $state(false);
  let container: HTMLElement;
  const current = $derived(selected.length === 1 ? selected[0]! : null);
  const busy = $derived(workspace.switching || workspace.copying || workspace.vaultRoot === null);

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

<section class="library" {hidden} aria-label="资料管理" bind:this={container}>
  <header class="library-heading">
    <div>
      <h1>资料管理</h1>
      <p>
        {workspace.vaultRoot?.split("/").at(-1) ?? "尚未打开资料夹"} · {workspace.files.length} 个文件
      </p>
    </div>
    <div class="create-actions">
      <button
        class="reader-button"
        type="button"
        disabled={busy}
        onclick={() => onAction("directory", current)}>新建文件夹</button
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
    <button
      class="reader-button"
      type="button"
      disabled={busy || current === null}
      onclick={() => onAction("rename", current)}>重命名</button
    >
    <button
      class="reader-button"
      type="button"
      disabled={busy || selected.length === 0}
      onclick={() => onAction("move", current)}>移动到…</button
    >
    <button
      class="reader-button"
      type="button"
      disabled={busy || selected.length === 0}
      onclick={() => onAction("trash", current)}>移到废纸篓</button
    >
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
    padding: 1.6rem 2rem 1rem;
  }
  h1 {
    font-size: 1.45rem;
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
  .library-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.5rem 2rem 1rem;
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
    grid-template-columns: minmax(0, 1fr) minmax(240px, 32%);
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
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
    }
  }
</style>
