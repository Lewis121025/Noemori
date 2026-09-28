<script lang="ts">
  /** 全局关系图谱：全窗口模态对话框，Esc 或关闭按钮退出，选中节点后关闭并打开。 */
  import { onMount } from "svelte";
  import type { GraphNode } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import GraphPanel from "./GraphPanel.svelte";

  let {
    workspace,
    onClose,
    onOpen,
  }: {
    workspace: ReaderWorkspaceController;
    onClose: () => void;
    /** 选中节点；对话框已先关闭。 */
    onOpen: (node: GraphNode) => void;
  } = $props();

  let dialog: HTMLDialogElement;

  onMount(() => {
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input[type=search]")?.focus();
  });
</script>

<dialog
  bind:this={dialog}
  class="graph-dialog"
  aria-label="关系图谱"
  oncancel={(event) => {
    event.preventDefault();
    onClose();
  }}
>
  <header>
    <h2>关系图谱</h2>
    <button type="button" class="close" aria-label="关闭关系图谱" onclick={onClose}
      ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg></button
    >
  </header>
  <div class="body">
    <GraphPanel
      {workspace}
      center={null}
      onOpen={(node) => {
        onClose();
        onOpen(node);
      }}
    />
  </div>
</dialog>

<style>
  .graph-dialog {
    width: calc(100vw - 2rem);
    height: calc(100dvh - 2rem);
    max-width: none;
    max-height: none;
    margin: 1rem;
    padding: 0;
    flex-direction: column;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.8rem;
    box-shadow: 0 16px 48px var(--shadow);
  }
  .graph-dialog[open] {
    display: flex;
  }
  .graph-dialog::backdrop {
    background: color-mix(in srgb, var(--fg) 20%, transparent);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.7rem 1rem 0.4rem;
  }
  h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .close {
    display: flex;
    padding: 0.3rem;
    border: 0;
    border-radius: 0.4rem;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .close:hover {
    background: var(--selected);
    color: var(--fg);
  }
  svg {
    width: 1.1rem;
    height: 1.1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 0 1rem 1rem;
  }
</style>
