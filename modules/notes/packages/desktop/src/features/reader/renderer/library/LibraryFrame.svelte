<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import type { VaultEntry } from "../../shared/api";
  import type { ArticleAgentActions } from "../../shared/article-conversations";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { isCompositionKey } from "../../shared/composition";
  import type { OpenContentLink } from "../editor/links/link-interaction";
  import LibraryPreview from "./LibraryPreview.svelte";

  let {
    workspace,
    hidden,
    entry,
    onCreate,
    onOpen,
    readFile,
    children,
    previewOpen = $bindable(false),
    previewTab = $bindable("article"),
    onClosePreview,
    onNewWhiteboard,
    onOpenVault,
    articleAgent,
    query,
    onFollowLink,
    focused = $bindable(false),
  }: {
    workspace: ReaderWorkspaceController;
    hidden: boolean;
    entry: VaultEntry | null;
    onCreate: (kind: "file" | "directory") => void;
    onOpen: (entry: VaultEntry) => void;
    readFile: (path: string) => Promise<Uint8Array>;
    children: Snippet;
    previewOpen?: boolean;
    previewTab?: "article" | "chat";
    onClosePreview: () => void;
    onNewWhiteboard?: () => void;
    onOpenVault?: () => void;
    articleAgent?: ArticleAgentActions;
    query: string;
    onFollowLink: OpenContentLink;
    focused?: boolean;
  } = $props();
  let compact = $state(false);
  let container: HTMLElement;
  let createMenu: HTMLDivElement;
  const id = $props.id();
  const busy = $derived(workspace.switching || workspace.copying);
  function create(kind: "file" | "directory" | "whiteboard"): void {
    createMenu.hidePopover();
    if (kind === "whiteboard") onNewWhiteboard?.();
    else onCreate(kind);
  }
  onMount(() => {
    const observer = new ResizeObserver(() => {
      compact = container.clientWidth < 650;
    });
    compact = container.clientWidth < 650;
    observer.observe(container);
    return () => observer.disconnect();
  });
  function previewKeydown(event: KeyboardEvent): void {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      isCompositionKey(event) ||
      hidden ||
      !(event.target instanceof Element) ||
      !container.contains(event.target) ||
      event.target.closest("dialog[open], [popover]")
    )
      return;
    if (compact && previewOpen) {
      event.preventDefault();
      onClosePreview();
    } else if (focused) {
      event.preventDefault();
      focused = false;
    }
  }
</script>

<svelte:window onkeydown={previewKeydown} />
<section
  class="library"
  class:compact
  class:focused
  class:preview-open={previewOpen}
  {hidden}
  aria-label="文件系统"
  bind:this={container}
>
  <header class="library-heading">
    <span class="vault-name" title={workspace.vaultRoot ?? "笔记库"}
      >{workspace.vaultRoot?.split(/[\\/]/).at(-1) || "笔记库"}</span
    >
    <div class="create-actions">
      {#if compact}<button
          class="reader-button preview-toggle"
          type="button"
          aria-label={previewOpen ? "返回列表" : "预览"}
          aria-pressed={previewOpen}
          disabled={!previewOpen && entry === null}
          onclick={() => {
            if (previewOpen) onClosePreview();
            else previewOpen = true;
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14v12H3zM8 4v12" /></svg
          >{previewOpen ? "返回" : "预览"}</button
        >{/if}
      <button
        class="reader-button primary"
        type="button"
        disabled={busy || workspace.vaultRoot === null}
        popovertarget={`${id}-create`}
        ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>新建</button
      >
      <div
        id={`${id}-create`}
        bind:this={createMenu}
        popover="auto"
        class="reader-popover create-menu"
        aria-label="新建项目"
      >
        <button
          class="reader-button"
          type="button"
          aria-label="新建笔记"
          onclick={() => create("file")}
          >笔记<span>{navigator.userAgent.includes("Mac") ? "⌘N" : "Ctrl+N"}</span></button
        >
        {#if onNewWhiteboard}<button
            class="reader-button"
            type="button"
            aria-label="新建白板"
            onclick={() => create("whiteboard")}>白板</button
          >{/if}
        <button
          class="reader-button"
          type="button"
          aria-label="新建文件夹"
          onclick={() => create("directory")}>文件夹</button
        >
      </div>
    </div>
  </header>
  {#if workspace.vaultRoot === null && onOpenVault}<div class="open-library">
      <button class="reader-button" type="button" onclick={onOpenVault}>打开笔记库…</button>
    </div>{/if}
  <div class="library-body">
    <div class="library-list" hidden={focused || (compact && previewOpen)}>
      {@render children()}
    </div>
    {#if !hidden && (!compact || previewOpen)}<LibraryPreview
        {entry}
        {workspace}
        {readFile}
        {onOpen}
        {busy}
        {query}
        {onFollowLink}
        bind:tab={previewTab}
        {focused}
        onFocus={() => {
          focused = !focused;
        }}
        {...articleAgent ? { articleAgent } : {}}
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
    gap: 12px;
    min-height: 43px;
    padding: 5px 15px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--border);
  }
  .vault-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
  }
  .create-actions {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .create-actions > button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: 12px;
    padding: 4px 9px;
    border-radius: 5px;
  }
  .create-actions .primary {
    background: var(--fg);
    color: var(--bg);
    border-color: transparent;
  }
  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  .library-body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(270px, 36%) minmax(0, 1fr);
  }
  .library-list {
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  .library-list[hidden] {
    display: none;
  }
  .focused .library-body,
  .compact .library-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .compact .library-list {
    border-right: 0;
  }
  .create-menu {
    min-width: 170px;
    padding: 5px;
  }
  .create-menu button {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    font-size: 12px;
  }
  .create-menu button:hover {
    background: var(--selected);
  }
  .create-menu span {
    color: var(--muted);
    font-size: 11px;
  }
  .open-library {
    padding: 12px;
  }
</style>
