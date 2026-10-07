<script lang="ts">
  import { tick } from "svelte";
  import type { AgentApi, AgentConversation } from "../shared/api";
  import { createCompositionGuard } from "../../reader/shared/composition";
  let {
    api,
    workspaces,
    onCreated,
  }: { api: AgentApi; workspaces: string[]; onCreated: (item: AgentConversation) => void } =
    $props();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let title = $state("新对话");
  let workspace = $state("");
  let busy = $state(false);
  let picking = $state(false);
  let error = $state("");
  const composition = createCompositionGuard();

  /** 打开尚未创建的会话表单；目录选择、取消和改名都不会启动模型或写入会话。 */
  export async function open(initialWorkspace = ""): Promise<void> {
    title = "新对话";
    workspace = initialWorkspace;
    error = "";
    dialog.showModal();
    await tick();
    input.focus();
    input.select();
  }
  async function pick(): Promise<void> {
    picking = true;
    try {
      const selected = await api.pickWorkspace();
      if (selected) workspace = selected;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      picking = false;
    }
  }
  async function create(): Promise<void> {
    if (busy || picking || composition.active || !workspace || !title.trim()) return;
    busy = true;
    error = "";
    try {
      const item = await api.create(workspace, title.trim());
      dialog.close();
      onCreated(item);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  class="new-conversation-dialog"
  aria-labelledby="new-conversation-title"
  bind:this={dialog}
  use:composition.bind
  oncancel={(event) => {
    if (busy || picking || composition.active) event.preventDefault();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void create();
    }}
  >
    <header>
      <h2 id="new-conversation-title">新建对话</h2>
      <p>先确认工作目录，再开始任务。</p>
    </header>
    <label for="conversation-title">会话名称</label>
    <input
      class="reader-input"
      id="conversation-title"
      bind:this={input}
      bind:value={title}
      maxlength="120"
      autocomplete="off"
      disabled={busy}
    />
    <label for="conversation-workspace">工作目录</label>
    <select
      class="reader-input"
      id="conversation-workspace"
      bind:value={workspace}
      disabled={busy || picking}
    >
      <option value="">选择工作目录</option>
      {#each [...new Set([...workspaces, ...(workspace ? [workspace] : [])])] as path (path)}<option
          value={path}>{path}</option
        >{/each}
    </select>
    <button
      class="reader-button choose-folder"
      type="button"
      disabled={busy || picking}
      onclick={() => void pick()}
      >{picking ? "正在选择…" : workspace ? "更换文件夹…" : "选择文件夹…"}</button
    >
    <p class="hint">助手将在这个文件夹中工作。需要访问其他位置时，会请求你的确认。</p>
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    <footer>
      <button
        class="reader-button"
        type="button"
        disabled={busy || picking}
        onclick={() => {
          if (!composition.active) dialog.close();
        }}>取消</button
      >
      <button
        class="reader-button primary"
        type="submit"
        disabled={busy || picking || !workspace || !title.trim()}
        >{busy ? "正在创建…" : "创建对话"}</button
      >
    </footer>
  </form>
</dialog>

<style>
  dialog {
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    padding: 1.5rem;
    box-shadow: 0 12px 48px var(--shadow);
  }
  dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  h2 {
    margin: 0;
    font-size: 1.2rem;
  }
  header p,
  .hint {
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.6;
  }
  label {
    font-size: 0.8rem;
  }
  .choose-folder {
    align-self: flex-start;
  }
  .error {
    color: var(--danger);
    font-size: 0.8rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
</style>
