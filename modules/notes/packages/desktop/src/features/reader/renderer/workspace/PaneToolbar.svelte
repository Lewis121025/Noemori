<script lang="ts">
  import type { ReaderWorkspaceController } from "./state.svelte";
  import type { ReaderPane } from "./pane.svelte";
  let {
    workspace,
    pane,
    onRename,
  }: {
    workspace: ReaderWorkspaceController;
    pane: ReaderPane;
    onRename: () => void;
  } = $props();
  const doc = $derived(pane.document);
  const navigation = $derived(pane.navigation);
  const busy = $derived(pane.switching || pane.copying || workspace.isComposing);
  const saveStatus = $derived(
    pane.copying
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
</script>

<div class="document-bar" role="group" aria-labelledby="document-name-{pane.id}">
  <span id="document-name-{pane.id}" class="document-name" title={doc.path ?? ""}
    >{doc.path?.split("/").at(-1) ?? "未打开文档"}</span
  >
  <span
    class="save-status"
    class:quiet={!doc.dirty && !doc.saving && doc.conflict === null && doc.saveError === null}
    role="status"
    title={saveStatus}>{doc.canEdit ? saveStatus : "只读预览"}</span
  >
  <div class="document-actions">
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="文内查找"
      title="文内查找（⌘/Ctrl+F）"
      disabled={busy || (doc.content?.kind !== "markdown" && doc.content?.kind !== "text")}
      onclick={() => navigation.openSearch()}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg
      >
    </button>
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="笔记操作"
      title="文档操作"
      popovertarget="note-menu-{pane.id}"
      disabled={busy || !doc.path}>⋯</button
    >
  </div>
</div>
<div id="note-menu-{pane.id}" popover="auto" class="reader-popover action-popover note-menu">
  <button
    class="reader-button"
    type="button"
    popovertarget="note-menu-{pane.id}"
    popovertargetaction="hide"
    disabled={busy || doc.path === null}
    onclick={() => {
      if (doc.path !== null) workspace.requestExport({ kind: "selection", paths: [doc.path] });
    }}>导出…</button
  >
  {#if doc.content?.kind === "markdown" && doc.canEdit}
    <button
      class="reader-button"
      type="button"
      popovertarget="note-menu-{pane.id}"
      popovertargetaction="hide"
      aria-label={pane.viewMode === "source" ? "切换排版视图" : "切换源码视图"}
      onclick={() => void pane.toggleViewMode()}
      >{pane.viewMode === "source" ? "返回排版" : "查看 Markdown 源码"}</button
    >
  {/if}

  <button
    class="reader-button"
    type="button"
    popovertarget="note-menu-{pane.id}"
    popovertargetaction="hide"
    onclick={onRename}
    disabled={doc.path === null || busy}>重命名…</button
  >
  <button
    class="reader-button"
    type="button"
    popovertarget="note-menu-{pane.id}"
    popovertargetaction="hide"
    onclick={pane.requestSave}
    disabled={!doc.canEdit || pane.switching || pane.copying || doc.saving}>保存</button
  >
</div>

<style>
  .document-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px;
    flex: 0 0 auto;
  }
  .document-name {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .save-status {
    color: var(--muted);
    font-size: 0.7rem;
    white-space: nowrap;
  }
  .document-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .action-popover {
    width: 13rem;
  }
  .action-popover button {
    display: block;
    width: 100%;
    text-align: left;
  }
  @media (max-width: 900px) {
    .save-status.quiet {
      display: none;
    }
  }
</style>
