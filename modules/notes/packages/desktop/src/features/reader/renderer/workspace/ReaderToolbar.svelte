<script lang="ts">
  import type { Snippet } from "svelte";
  import OutlineTree from "../navigation/OutlineTree.svelte";
  import WorkspaceFeedback from "./WorkspaceFeedback.svelte";
  import type { ReaderWorkspaceController } from "./state.svelte";
  import type { ReaderSpace } from "../../shared/api";

  let {
    workspace,
    space,
    changingSpace,
    onLibrary,
    onResume,
    onConnections,
    documentVisible,
    onSearch,
    onNewNote,
    onNewWhiteboard,
    onOpenVault,
    filesCollapsed,
    onToggleFiles,
    onRename,
    onDocumentAction,
    applicationMenu,
  }: {
    workspace: ReaderWorkspaceController;
    space: ReaderSpace;
    changingSpace: boolean;
    onLibrary: () => void;
    onResume: () => void;
    onConnections: () => void;
    documentVisible: boolean;
    onSearch: () => void;
    onNewNote: () => void;
    onNewWhiteboard: () => void;
    onOpenVault: () => void;
    filesCollapsed: boolean;
    onToggleFiles: () => void;
    onRename: () => void;
    onDocumentAction: () => void;
    applicationMenu: Snippet;
  } = $props();
  const doc = $derived(workspace.document);
  const busy = $derived(changingSpace || workspace.switching || workspace.copying);
  const navigation = $derived(workspace.navigation);
  let outlinePopover: HTMLElement | undefined = $state();
  let filesToggle: HTMLButtonElement;
  let noteMenu: HTMLDivElement;
  let noteMenuButton: HTMLButtonElement | undefined = $state();
  const saveStatus = $derived(
    workspace.copying
      ? "正在保存副本…"
      : doc.saving
        ? "正在保存…"
        : doc.conflict !== null
          ? "存在保存冲突"
          : doc.saveError !== null
            ? "保存失败"
            : doc.dirty
              ? "未保存"
              : "已保存",
  );

  function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  function jumpOutline(pos: number): void {
    outlinePopover?.hidePopover();
    navigation.jumpOutline(pos);
  }
  /** 辅助面板独立于菜单；先把焦点交回稳定入口，关闭面板时不会返回隐藏的菜单项。 */
  function openDocumentPanel(id: string): void {
    const panel = document.getElementById(id);
    if (!(panel instanceof HTMLElement)) return;
    onDocumentAction();
    noteMenu.hidePopover();
    noteMenuButton?.focus();
    panel.showPopover();
    // Tab 从面板内的第一个控件开始，不依赖工具条与文档栏的 DOM 顺序。
    panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
  }
  /** 窄窗口关闭文件栏后，焦点回到稳定可见的入口，避免落在隐藏控件上。 */
  export function focusFilesToggle(): void {
    filesToggle.focus();
  }
</script>

<header class="toolbar">
  <div class="brand">
    <button
      bind:this={filesToggle}
      type="button"
      class="reader-button icon-button"
      aria-label="显示或隐藏文件栏"
      aria-pressed={!filesCollapsed}
      onclick={onToggleFiles}
      title="显示或隐藏文件栏"
      hidden={space !== "writing"}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14" /></svg
      >
    </button>
    <button
      type="button"
      class="reader-button library-button"
      popovertarget="library-menu"
      disabled={busy}
      aria-label="切换笔记库"
      title={workspace.vaultRoot ?? "Nous"}
    >
      <span>{workspace.vaultRoot === null ? "Nous" : basename(workspace.vaultRoot)}</span>
      <svg class="reader-icon chevron" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m8 10 4 4 4-4" /></svg
      >
    </button>
  </div>
  <nav class="spaces" aria-label="工作空间">
    <button
      class="space-button"
      type="button"
      aria-label="阅读与写作"
      aria-current={space === "writing" ? "page" : undefined}
      disabled={busy}
      onclick={onResume}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M4 19.5h16M6 15l1-4L16 2l4 4-9 9-5 1M14 4l4 4" /></svg
      >写作
    </button>
    <button
      class="space-button"
      type="button"
      aria-label="资料管理"
      aria-current={space === "library" ? "page" : undefined}
      disabled={busy}
      onclick={onLibrary}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M4 9h16M9 9v11" /></svg
      >资料
    </button>
    <button
      class="space-button"
      type="button"
      aria-label="关联与白板"
      aria-current={space === "connections" ? "page" : undefined}
      disabled={busy}
      onclick={onConnections}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><circle cx="6" cy="6" r="3" /><circle cx="18" cy="7" r="3" /><circle
          cx="12"
          cy="19"
          r="3"
        /><path d="m8.7 6.3 6.3.4M7.3 8.7l3.4 7.6m6-6.6-3.4 6.6" /></svg
      >关联
    </button>
  </nav>
  <div class="actions">
    <WorkspaceFeedback {workspace} />
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="查找"
      title="查找笔记"
      onclick={onSearch}
      disabled={workspace.vaultRoot === null || busy}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg
      >
    </button>
    {#if space === "writing"}
      <button
        class="reader-button icon-button"
        type="button"
        aria-label="新建笔记"
        title="新建笔记"
        onclick={onNewNote}
        disabled={busy || workspace.isComposing}
      >
        <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M12 5H5v14h14v-7M14 4l6 6M10 14l1-5 7-7 4 4-7 7-5 1" /></svg
        >
      </button>
    {:else if space === "connections"}
      <button
        class="reader-button icon-button"
        type="button"
        aria-label="新建白板"
        title="新建白板"
        onclick={onNewWhiteboard}
        disabled={busy || workspace.isComposing}
      >
        <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M12 8v8m-4-4h8" /></svg
        >
      </button>
    {/if}
    {#if documentVisible && navigation.hasOutline}
      <button
        class="reader-button icon-button"
        type="button"
        popovertarget="outline-panel"
        aria-label="目录"
        title="目录"
        onclick={onDocumentAction}
        disabled={busy}
      >
        <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg
        >
      </button>
    {/if}
    {#if documentVisible && doc.path !== null}
      <button
        type="button"
        class="reader-button icon-button"
        popovertarget="note-menu"
        aria-label="笔记操作"
        bind:this={noteMenuButton}
        disabled={busy}
        title="更多操作"
        onclick={onDocumentAction}
      >
        <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle
            cx="19"
            cy="12"
            r="1"
          /></svg
        >
      </button>
    {/if}
  </div>
</header>
{#if documentVisible && doc.path !== null && space === "writing"}
  <div class="document-bar">
    <span class="document-name" title={doc.path}>{basename(doc.path)}</span>
    <span
      class="save-status"
      class:quiet={!doc.dirty &&
        !doc.saving &&
        !workspace.copying &&
        doc.saveError === null &&
        doc.conflict === null}
      role="status">{doc.canEdit ? saveStatus : "只读预览"}</span
    >
    {#if doc.content?.kind === "markdown" && doc.canEdit}
      <button
        class="reading-toggle"
        type="button"
        aria-label={workspace.viewMode === "reading" ? "退出阅读视图" : "切换阅读视图"}
        aria-pressed={workspace.viewMode === "reading"}
        onclick={() => void workspace.toggleReadingMode()}
        disabled={busy || workspace.isComposing}
        >{workspace.viewMode === "reading" ? "阅读" : "编辑"}</button
      >
    {/if}
  </div>
{/if}

<div id="library-menu" popover="auto" class="reader-popover action-popover library-menu">
  <button
    class="reader-button"
    type="button"
    popovertarget="library-menu"
    popovertargetaction="hide"
    onclick={onOpenVault}
    disabled={busy}>打开笔记库…</button
  >
  {@render applicationMenu()}
</div>
<div
  id="note-menu"
  bind:this={noteMenu}
  popover="auto"
  class="reader-popover action-popover note-menu"
>
  {#if doc.content?.kind === "markdown"}
    {#if workspace.viewMode !== "source"}<button
        class="reader-button"
        type="button"
        onclick={() => openDocumentPanel(`properties-editor-formatting-${workspace.activePane.id}`)}
        >笔记属性…</button
      >{/if}
    <button
      class="reader-button"
      type="button"
      onclick={() => openDocumentPanel(`document-graph-${workspace.activePane.id}`)}
      >关联图谱…</button
    >
  {/if}
  {#if doc.content?.kind === "markdown" && workspace.viewMode === "wysiwyg"}
    <button
      class="reader-button"
      type="button"
      aria-label="文本格式"
      aria-controls="editor-formatting-{workspace.activePane.id}"
      onclick={() => openDocumentPanel(`editor-formatting-${workspace.activePane.id}`)}
      onmousedown={(event) => event.preventDefault()}>文本格式…</button
    >
  {/if}
  {#if doc.content?.kind === "markdown" && doc.canEdit}
    <button
      class="reader-button"
      type="button"
      popovertarget="note-menu"
      popovertargetaction="hide"
      aria-label={workspace.viewMode === "source" ? "切换排版视图" : "切换源码视图"}
      onclick={() => void workspace.toggleViewMode()}
      >{workspace.viewMode === "source" ? "返回排版" : "查看 Markdown 源码"}</button
    >
  {/if}
  <button
    class="reader-button"
    type="button"
    popovertarget="note-menu"
    popovertargetaction="hide"
    aria-label={workspace.split ? "合并分栏" : "拆分为两栏"}
    onclick={() => void workspace.toggleSplit()}
    disabled={busy || workspace.isComposing}
    >{workspace.split ? "关闭另一栏" : "并排查看另一篇"}</button
  >
  {#if doc.content?.kind === "markdown" || doc.content?.kind === "text"}<button
      class="reader-button"
      type="button"
      popovertarget="note-menu"
      popovertargetaction="hide"
      aria-label="文内查找"
      onclick={() => navigation.openSearch()}>查找文中内容…</button
    >{/if}

  <button
    class="reader-button"
    type="button"
    popovertarget="note-menu"
    popovertargetaction="hide"
    onclick={onRename}
    disabled={doc.path === null || busy}>重命名…</button
  >
  <button
    class="reader-button"
    type="button"
    popovertarget="note-menu"
    popovertargetaction="hide"
    onclick={workspace.requestSave}
    disabled={!doc.canEdit || busy || doc.saving}>保存</button
  >
</div>
<div
  id="outline-panel"
  popover="auto"
  class="reader-popover outline-popover"
  bind:this={outlinePopover}
>
  <div class="popover-heading">本文目录</div>
  <nav aria-label="文档目录">
    <OutlineTree
      nodes={navigation.outlineTree}
      collapsed={navigation.collapsedKeys}
      onToggle={navigation.toggleOutline}
      onJump={jumpOutline}
    />
  </nav>
</div>

<style>
  .toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 1rem;
    min-height: 68px;
    flex-shrink: 0;
    padding: 0.8rem 1.4rem;
    border-bottom: 1px solid var(--border);
    background: var(--chrome);
  }
  .brand,
  .actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }
  .actions {
    justify-content: flex-end;
  }
  .toolbar .reader-button {
    border-color: transparent;
    background: transparent;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .toolbar .reader-button:hover:not(:disabled) {
    background: var(--selected);
  }
  .toolbar button[hidden] {
    display: none;
  }
  .toolbar .icon-button {
    padding: 0.4rem;
    color: var(--muted);
  }
  .toolbar .icon-button:hover {
    color: var(--fg);
  }
  .library-button {
    max-width: 12rem;
    min-width: 0;
    font-weight: 550;
  }
  .library-button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chevron {
    width: 0.8rem;
    color: var(--muted);
  }
  .spaces {
    display: flex;
    padding: 4px;
    gap: 2px;
    border-radius: 11px;
    background: var(--sidebar);
  }
  .space-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    min-height: 32px;
    padding: 0.3rem 1.2rem;
    cursor: pointer;
    transition:
      background var(--motion-fast),
      color var(--motion-fast),
      box-shadow var(--motion-fast);
  }
  .space-button .reader-icon {
    width: 16px;
    height: 16px;
  }
  .space-button:hover:not(:disabled) {
    color: var(--fg);
  }
  .space-button[aria-current="page"] {
    color: var(--fg);
    background: var(--surface);
    box-shadow: 0 1px 4px var(--shadow);
  }
  .space-button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .document-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-height: 44px;
    padding: 0.5rem 2rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    color: var(--muted);
  }
  .document-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
  }
  .save-status {
    white-space: nowrap;
    font-size: 0.72rem;
    color: var(--warning);
  }
  .reading-toggle {
    margin-left: auto;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
    border-radius: 5px;
    cursor: pointer;
  }
  .reading-toggle[aria-pressed="true"] {
    background: var(--selected);
    color: var(--fg);
  }
  .quiet {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .library-menu {
    inset-inline-start: 1rem;
    inset-inline-end: auto;
  }
  .action-popover {
    width: 12rem;
  }
  .action-popover button {
    display: block;
    width: 100%;
    border-color: transparent;
    background: transparent;
    text-align: left;
    padding: 0.5rem 0.65rem;
  }
  .outline-popover {
    width: 17rem;
    max-height: min(65vh, 32rem);
    overflow: auto;
    padding: 0.75rem;
  }
  .popover-heading {
    font-size: 0.75rem;
    color: var(--muted);
    margin: 0.25rem 0.35rem 0.6rem;
  }
  @media (max-width: 800px) {
    .toolbar {
      gap: 0.5rem;
      padding: 0.7rem;
    }
    .space-button {
      padding: 0.3rem 0.75rem;
    }
    .brand {
      gap: 0.1rem;
    }
    .library-button {
      max-width: 7rem;
    }
  }
  @media (max-width: 640px) {
    .toolbar {
      grid-template-columns: minmax(0, 1fr) auto;
      row-gap: 0.65rem;
    }
    .spaces {
      grid-row: 2;
      grid-column: 1 / -1;
      justify-self: stretch;
    }
    .space-button {
      flex: 1;
    }
    .actions {
      grid-column: 2;
      grid-row: 1;
    }
    .document-bar {
      padding: 0.4rem 1rem;
    }
  }
</style>
