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
    onSearch,
    onNewNote,
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
    onSearch: () => void;
    onNewNote: () => void;
    onOpenVault: () => void;
    filesCollapsed: boolean;
    onToggleFiles: () => void;
    onRename: () => void;
    onDocumentAction: () => void;
    applicationMenu: Snippet;
  } = $props();
  const doc = $derived(workspace.document);
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
  }
  /** 窄窗口关闭文件栏后，焦点回到稳定可见的入口，避免落在隐藏控件上。 */
  export function focusFilesToggle(): void {
    filesToggle.focus();
  }
</script>

<header class="toolbar">
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
    class="reader-button space-button"
    type="button"
    disabled={changingSpace || workspace.switching || workspace.copying}
    onclick={space === "writing" ? onLibrary : onResume}
  >
    {space === "writing" ? "资料管理" : "返回阅读与写作"}
  </button>
  <button
    type="button"
    class="reader-button library-button"
    popovertarget="library-menu"
    disabled={workspace.switching || workspace.copying}
    aria-label="切换笔记库"
  >
    {workspace.vaultRoot === null ? "Nous" : basename(workspace.vaultRoot)}
    <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
  </button>
  <div class="document-heading">
    <span class="document-name" title={doc.path ?? undefined}
      >{space === "library" || doc.path === null ? "" : basename(doc.path)}</span
    >
    {#if space === "writing" && doc.path !== null}
      <span
        class="save-status"
        class:quiet={!doc.dirty &&
          !doc.saving &&
          !workspace.copying &&
          doc.saveError === null &&
          doc.conflict === null}
        role="status">{doc.canEdit ? saveStatus : "只读预览"}</span
      >
    {/if}
  </div>
  <WorkspaceFeedback {workspace} />
  {#if space === "writing"}
    <button
      class="reader-button"
      type="button"
      onclick={onSearch}
      disabled={workspace.vaultRoot === null || workspace.switching}>查找</button
    >
    <button
      class="reader-button"
      type="button"
      aria-label="新建笔记"
      onclick={onNewNote}
      disabled={workspace.switching}>新建</button
    >
    {#if navigation.hasOutline}
      <button
        class="reader-button icon-button"
        type="button"
        popovertarget="outline-panel"
        aria-label="目录"
        title="目录"
        onclick={onDocumentAction}
        disabled={workspace.switching || workspace.copying}
      >
        <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg
        >
      </button>
    {/if}
    {#if doc.path !== null}
      <button
        type="button"
        class="reader-button icon-button"
        popovertarget="note-menu"
        aria-label="笔记操作"
        bind:this={noteMenuButton}
        disabled={workspace.switching || workspace.copying}
        title="笔记操作"
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
  {/if}
</header>

<div id="library-menu" popover="auto" class="reader-popover action-popover library-menu">
  <button
    class="reader-button"
    type="button"
    popovertarget="library-menu"
    popovertargetaction="hide"
    onclick={onOpenVault}
    disabled={workspace.switching || workspace.copying}>打开笔记库…</button
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
    <button
      class="reader-button"
      type="button"
      popovertarget="note-menu"
      popovertargetaction="hide"
      aria-label={workspace.viewMode === "reading" ? "退出阅读视图" : "切换阅读视图"}
      onclick={() => void workspace.toggleReadingMode()}
      >{workspace.viewMode === "reading" ? "允许编辑" : "只读阅读"}</button
    >
  {/if}
  <button
    class="reader-button"
    type="button"
    popovertarget="note-menu"
    popovertargetaction="hide"
    aria-label={workspace.split ? "合并分栏" : "拆分为两栏"}
    onclick={() => void workspace.toggleSplit()}
    disabled={workspace.switching || workspace.copying || workspace.isComposing}
    >{workspace.split ? "关闭另一栏" : "并排查看另一篇"}</button
  >
  {#if doc.canEdit}<button
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
    disabled={doc.path === null || workspace.switching || workspace.copying}>重命名…</button
  >
  <button
    class="reader-button"
    type="button"
    popovertarget="note-menu"
    popovertargetaction="hide"
    onclick={workspace.requestSave}
    disabled={!doc.canEdit || workspace.switching || workspace.copying || doc.saving}>保存</button
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
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 3.5rem;
    flex-shrink: 0;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar);
  }
  .toolbar button {
    border-color: transparent;
    background: transparent;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .toolbar button[aria-pressed="true"] {
    background: var(--selected);
  }
  .toolbar button[hidden] {
    display: none;
  }

  .toolbar .icon-button {
    padding: 0.4rem;
  }
  .library-button {
    max-width: 12rem;
    overflow: hidden;
    white-space: nowrap;
  }
  .document-heading {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.7rem;
  }
  .document-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .save-status {
    white-space: nowrap;
    font-size: 0.75rem;
    color: var(--muted);
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
  @media (max-width: 640px) {
    .toolbar {
      padding: 0.5rem;
      gap: 0.2rem;
    }
    .library-button {
      max-width: 7rem;
    }
    .document-name {
      font-size: 0.8rem;
    }
    .document-heading {
      flex-direction: column;
      gap: 0;
    }
  }
</style>
