<script lang="ts">
  import WorkspaceFeedback from "./WorkspaceFeedback.svelte";
  import type { Snippet } from "svelte";
  import type { ReaderWorkspaceController } from "./state.svelte";

  let {
    workspace,
    filesCollapsed,
    documentVisible,
    busy,
    onToggleFiles,
    onToggleSplit,
    documentTools,
    onPrepareDocumentAction,
    agentOpen = false,
    onOpenAgent,
  }: {
    workspace: ReaderWorkspaceController;
    filesCollapsed: boolean;
    documentVisible: boolean;
    busy: boolean;
    onToggleFiles: () => void;
    onToggleSplit: () => void;
    documentTools: Snippet;
    onPrepareDocumentAction: () => void;
    agentOpen?: boolean;
    onOpenAgent?: () => void;
  } = $props();
  const mac = navigator.userAgent.includes("Mac");
  let sidebarToggle: HTMLButtonElement;
  /** 侧栏关闭后将键盘焦点交回固定开关，不依赖已隐藏的侧栏内容。 */
  export function focusSidebarToggle(): void {
    sidebarToggle.focus({ preventScroll: true });
  }
  /** 窄窗口的工具横向滚动，键盘焦点须完整可见；顶层菜单和查找浮层自行管理位置。 */
  function revealTool(event: FocusEvent): void {
    const target = event.target;
    if (
      target instanceof HTMLButtonElement &&
      target.closest('[role="toolbar"]') &&
      !target.closest("[popover]")
    )
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
</script>

<header class="window-toolbar" class:mac aria-label="窗口工具栏">
  <div class="window-navigation">
    <button
      bind:this={sidebarToggle}
      class="reader-button icon-button"
      type="button"
      aria-label="显示或隐藏文件栏"
      title={filesCollapsed ? "展开侧栏" : "收起侧栏"}
      aria-expanded={!filesCollapsed}
      onclick={onToggleFiles}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14" /></svg
      >
    </button>
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="后退"
      title="后退"
      disabled={busy || !documentVisible || !workspace.history.canBack}
      onclick={() => void workspace.navigateBack()}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m10 5-7 7 7 7M3 12h18" /></svg
      >
    </button>
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="前进"
      title="前进"
      disabled={busy || !documentVisible || !workspace.history.canForward}
      onclick={() => void workspace.navigateForward()}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m14 5 7 7-7 7M3 12h18" /></svg
      >
    </button>
  </div>
  <div
    class="window-document-tools"
    role="group"
    aria-label="当前文档工具"
    hidden={!documentVisible}
    onpointerdown={onPrepareDocumentAction}
    onfocusin={revealTool}
  >
    {@render documentTools()}
  </div>
  <div class="window-actions">
    <WorkspaceFeedback {workspace} />
    {#if workspace.split}
      <div class="pane-switch" role="group" aria-label="切换分栏">
        {#each workspace.panes as pane, index (pane.id)}
          <button
            class="reader-button"
            type="button"
            aria-label={index === 0 ? "切换到左栏" : "切换到右栏"}
            aria-pressed={workspace.activePane === pane}
            title={pane.document.path ?? "空分栏"}
            disabled={busy || !documentVisible}
            onclick={() => workspace.activatePane(pane.id)}>{index === 0 ? "左栏" : "右栏"}</button
          >
        {/each}
      </div>
    {/if}
    <button
      class="reader-button icon-button"
      type="button"
      aria-label={workspace.split ? "关闭双栏" : "在另一栏打开…"}
      title={workspace.split ? "保留当前栏，关闭双栏" : "在另一栏打开文档"}
      aria-pressed={workspace.split}
      disabled={busy || !documentVisible}
      onclick={onToggleSplit}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg
      >
    </button>
    {#if onOpenAgent}<button
        class="reader-button agent-entry"
        type="button"
        aria-label="工作区助手"
        aria-pressed={agentOpen}
        aria-expanded={agentOpen}
        title={agentOpen ? "收起 Agent 侧栏" : "展开 Agent 侧栏"}
        onclick={onOpenAgent}
        ><svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z" /><path
            d="M8 9h9M8 13h6"
          /></svg
        ><span>Agent</span></button
      >{/if}
  </div>
</header>

<style>
  .window-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 44px;
    height: 44px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--chrome);
    -webkit-app-region: drag;
    user-select: none;
    gap: 12px;
    min-width: 0;
  }
  .window-toolbar.mac {
    padding-left: 88px;
  }
  .window-navigation,
  .window-actions,
  .pane-switch {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .agent-entry {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .agent-entry[aria-pressed="true"] {
    background: var(--selected);
    color: var(--accent);
  }
  .window-toolbar :global(button),
  .window-toolbar :global([popover]),
  .window-document-tools {
    -webkit-app-region: no-drag;
  }
  .window-navigation,
  .window-actions {
    flex: 0 0 auto;
  }
  .window-document-tools {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .window-document-tools::-webkit-scrollbar {
    display: none;
  }
  .window-document-tools[hidden] {
    display: none;
  }
  .window-document-tools :global(.topbar-document),
  .window-document-tools :global(.editor-tools) {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .window-document-tools :global(.topbar-document[hidden]) {
    display: none;
  }
  .window-document-tools :global(.pane-tools) {
    display: contents;
  }
  .window-document-tools :global(.editor-tools) {
    flex: 1;
  }
  .window-document-tools :global(.formatting-panel),
  .window-document-tools :global(.code-toolbar),
  .window-document-tools :global(.board-toolbar),
  .window-document-tools :global(.preview-toolbar) {
    flex-wrap: nowrap;
    background: transparent;
    border: 0;
    margin: 0;
    padding: 0 4px;
  }
  .window-document-tools :global(.formatting-panel) {
    flex: 0 0 auto;
    min-width: max-content;
  }
  .window-document-tools :global(.search-panel) {
    position: fixed;
    top: 52px;
    right: 12px;
    z-index: 20;
    width: min(32rem, calc(100vw - 24px));
    max-height: calc(100vh - 64px);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--chrome);
    box-shadow: 0 8px 30px var(--shadow);
  }
  .pane-switch {
    gap: 2px;
    border-radius: 7px;
    background: var(--sidebar);
  }
  .pane-switch button {
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
  }
</style>
