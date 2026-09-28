<script lang="ts">
  import type { ReaderWorkspaceController } from "./state.svelte";
  import type { ReaderPane } from "./pane.svelte";
  import SaveNotice from "./SaveNotice.svelte";

  let { workspace }: { workspace: ReaderWorkspaceController } = $props();
  const savePanes = $derived(
    workspace.panes.filter(
      ({ document: doc }) => doc.path !== null && (doc.conflict !== null || doc.saveError !== null),
    ),
  );
  const saveIssue = $derived(savePanes.length > 0);
  const hasFeedback = $derived(
    saveIssue || workspace.healthMessage !== "" || workspace.message !== "",
  );
  const needsAttention = $derived(
    saveIssue || workspace.healthMessage !== "" || workspace.messageNeedsAttention,
  );
  const label = $derived(
    saveIssue ? "处理保存问题" : workspace.healthMessage ? "查看后台问题" : "查看操作消息",
  );
  const summary = $derived(
    saveIssue
      ? `${savePanes.map((pane) => pane.document.path).join("、")} 保存需要处理，当前内容仍保留。打开工具栏的“处理保存问题”查看原因和处理方式。`
      : workspace.healthMessage || workspace.message,
  );
  let panel: HTMLElement | undefined = $state();
  let panelOpen = $state(false);
  let returnFocus: HTMLElement | null = null;

  $effect(() => {
    // 问题按分栏归属，切换活动栏不撤掉其他栏的处理入口，也不自动抢走写作焦点。
    if (panelOpen && !hasFeedback) panel?.hidePopover();
  });

  /** 用户明确定位时才改变活动栏；保存操作始终直接绑定问题所属的栏。 */
  function showPane(pane: ReaderPane): void {
    panel?.hidePopover();
    workspace.activatePane(pane.id);
    pane.navigation.focusEditor();
  }

  function onToggle(event: ToggleEvent): void {
    if (event.newState !== "closed") return;
    panelOpen = false;
    const active = document.activeElement;
    // 点击别处关闭时尊重新目标；Esc、关闭按钮或处理成功时回到原来的写作位置。
    if (active !== document.body && active !== null && !panel?.contains(active)) return;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    else workspace.navigation.focusEditor();
  }
</script>

{#if hasFeedback}
  <span class="feedback-announcement" role={needsAttention ? "alert" : "status"}>{summary}</span>
  <button
    class="reader-button feedback-button"
    class:warning={needsAttention}
    type="button"
    aria-label={label}
    title={label}
    popovertarget="workspace-feedback"
    onmousedown={(event) => event.preventDefault()}
    disabled={workspace.isComposing || workspace.switching}
  >
    <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
      ><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3v1" /></svg
    >
  </button>
{/if}

<section
  id="workspace-feedback"
  bind:this={panel}
  popover="auto"
  class="reader-popover feedback-panel"
  aria-label="工作区消息"
  onbeforetoggle={(event) => {
    if (event.newState !== "open") return;
    panelOpen = true;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }}
  ontoggle={onToggle}
>
  <div class="feedback-heading">
    <h2>{saveIssue ? "保存需要处理" : "工作区消息"}</h2>
    <!-- svelte-ignore a11y_autofocus (仅用户打开面板时由浏览器同步分配焦点，避免快速 Esc 误退出源码编辑。) -->
    <button
      autofocus
      class="reader-button close-button"
      type="button"
      aria-label="关闭消息面板"
      popovertarget="workspace-feedback"
      popovertargetaction="hide"
      ><svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m6 6 12 12M6 18 18 6" /></svg
      ></button
    >
  </div>
  {#each savePanes as pane (pane.id)}
    <section class="save-issue" aria-label={`保存问题：${pane.document.path}`}>
      <h3>{pane.document.path}</h3>
      {#if pane.id !== workspace.activePane.id}
        <button
          class="reader-button"
          type="button"
          aria-label={`前往笔记：${pane.document.path}`}
          onclick={() => showPane(pane)}>前往笔记</button
        >
      {/if}
      {#key pane.document.epoch}
        <SaveNotice
          doc={pane.document}
          copying={pane.copying}
          saveCopy={pane.saveCopy}
          requestSave={pane.requestSave}
          snapshot={pane.navigation.snapshot}
        />
      {/key}
    </section>
  {/each}
  {#if workspace.healthMessage}
    <p class="health-notice">{workspace.healthMessage}</p>
  {/if}
  {#if workspace.message}
    <div class="message">
      <p>{workspace.message}</p>
      {#if workspace.messageDetail}
        <details class="message-details">
          <summary>查看详细原因</summary>
          <p>{workspace.messageDetail}</p>
        </details>
      {/if}
      <button class="reader-button" type="button" onclick={workspace.dismissMessage}>知道了</button>
    </div>
  {/if}
</section>

<style>
  .feedback-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 32px;
    padding: var(--space-1);
    border-color: transparent;
    background: transparent;
    color: var(--accent);
  }
  .feedback-button.warning {
    color: var(--warning);
  }
  .feedback-announcement {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .feedback-panel {
    width: 42rem;
    padding: var(--space-4);
  }
  .feedback-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
  }
  .feedback-heading h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .save-issue {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
  .save-issue h3 {
    margin: 0;
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .save-issue > button {
    justify-self: start;
  }
  .close-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-1);
    border-color: transparent;
    background: transparent;
  }
  .health-notice,
  .message {
    margin: var(--space-3) 0 0;
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  .message p {
    margin: 0 0 var(--space-3);
  }
  .message-details {
    margin-bottom: var(--space-3);
    color: var(--muted);
    font-size: 0.8rem;
  }
  .message-details summary {
    min-height: 32px;
    align-content: center;
    cursor: pointer;
  }
</style>
